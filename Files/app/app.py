"""
NOR Dashboard - a simple admin dashboard for a Rust server.
Talks to the server over WebRcon and to the Steam Web API for player lookups.
Runs locally only (127.0.0.1) since config.json holds the RCON password.
"""
import json
import logging
import os
import re
import threading
import time
import types
from logging.handlers import RotatingFileHandler

from flask import Flask, jsonify, render_template, request
from flask_sock import Sock
from werkzeug.exceptions import HTTPException

import modules as module_loader
from ban_commands import ban_player, broadcast_message, get_banned_steamids, give_item, kick_player, unban_player
from battlemetrics import get_server_stats
from entity_history import get_history as get_entity_history, record_sample as record_entity_sample
from map_data import get_map_image
from map_entities import get_world_events
from oxide_commands import (
    add_user_to_group,
    create_group,
    grant_permission,
    list_group_names,
    remove_group,
    remove_user_from_group,
    revoke_permission,
    show_group,
    show_user,
)
from permissions_catalog import KNOWN_PERMISSIONS
from player_notes import add_note, delete_note, force_full_sync, get_notes, search_notes
from player_stats import get_all_stats, get_stats, record_snapshot, sync_with_remote
from rcon_client import RconClient, RconError, get_log_since, get_log_tail, get_players
from server_info import SETTING_CONVARS, get_server_info, get_server_settings, set_convar
from steam_api import get_player_bans_cached, get_player_summary, get_rust_playtime_hours, lookup_player
from updater import apply_update, check_for_update

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
# VERSION lives one level up, at the repo root, alongside run.bat/install.bat
# - everything else app.py needs is colocated here in app/.
VERSION_PATH = os.path.join(BASE_DIR, "..", "VERSION")

with open(VERSION_PATH, "r", encoding="utf-8") as f:
    VERSION = f.read().strip()

# A curated reference list for the Console tab's Give Item picker - static,
# not user-editable at runtime like permissions_catalog.json, so it's just
# loaded straight from the repo copy rather than getting its own module.
with open(os.path.join(BASE_DIR, "item_catalog.json"), "r", encoding="utf-8") as f:
    ITEM_CATALOG = json.load(f)

# A small, persistent "what happened" log, separate from dashboard.log (raw
# stdout/stderr from run.bat - overwritten fresh every launch). Rotates
# instead of growing forever, but otherwise deliberately plain - just
# RCON connects/drops, AMAP actions, settings changes, and anything
# unhandled, with a timestamp, so an issue can be traced after the fact
# without needing to reproduce it live.
LOG_PATH = os.path.join(BASE_DIR, "..", "dashboard-events.log")
logger = logging.getLogger("nor_dashboard")
logger.setLevel(logging.INFO)
_log_handler = RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
_log_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_log_handler)

app = Flask(__name__)
# Without this, Flask only reads templates/index.html once per process start
# and caches it in memory - any wording/HTML edit needs a full restart to
# show up otherwise. This makes it check the file's timestamp every render.
app.config["TEMPLATES_AUTO_RELOAD"] = True
# Static files (app.js, style.css) default to a 12-hour browser cache
# otherwise - completely separate from the template setting above, and easy
# to miss, since the symptom is "I edited the JS but the browser's still
# running the old version" rather than an outright error.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# Always created, even if no loaded module ends up using it - flask-sock
# ships as a core dependency regardless of which modules are installed
# (see requirements.txt's own note), so there's no real cost to having
# this ready for whichever module wants it (currently just Terminal).
sock = Sock(app)

_rcon_client = None
# Guards the check-then-create in get_rcon_client()/reset_rcon_client() -
# without this, two concurrent requests (the dev server runs threaded=True,
# and several background loops below also call get_rcon_client()) could
# both see _rcon_client as None and each create their own RconClient. Both
# would open a real WebSocket to the same Rust server, and since WebRcon
# broadcasts every console line to every connected client, the orphaned
# one (silently overwritten in the global, but still running its own
# _reader_loop forever - nothing ever closes it) would keep logging every
# line a second time, right alongside the "real" one. This is the actual
# cause of a since-reported "console shows everything twice" bug.
_rcon_client_lock = threading.Lock()

# The browser pings /api/heartbeat every few seconds while the dashboard page
# is open; _heartbeat_watchdog_loop shuts the whole process down once those
# pings stop, which is how closing the dashboard's browser window closes the
# dashboard itself now that it runs windowless (see run.bat). Set at import
# time rather than inside __main__ so it also doubles as "process start" for
# the grace period below.
#
# HEARTBEAT_TIMEOUT_SECONDS has some margin built in (not e.g. 15s) since
# Chromium-based browsers can throttle a backgrounded tab's timers down to
# roughly once a minute - too tight a timeout would risk shutting the
# dashboard down just from switching windows for a bit, not from actually
# closing it. 90s tolerates that throttling while still shutting down
# within about a minute and a half of a real close.
_last_heartbeat = time.time()
_process_start = time.time()
HEARTBEAT_TIMEOUT_SECONDS = 90
HEARTBEAT_GRACE_SECONDS = 30
WATCHDOG_CHECK_INTERVAL_SECONDS = 10
PLAYER_STATS_SYNC_INTERVAL_SECONDS = 300
ENTITY_HISTORY_INTERVAL_SECONDS = 300

# Background task last-run tracking — updated by each loop, read by DevTools.
_task_heartbeats_lock = threading.Lock()
_task_heartbeats = {}

def _record_task_run(name, status="ok", detail=""):
    with _task_heartbeats_lock:
        _task_heartbeats[name] = {"last_run": time.time(), "status": status, "detail": detail}

def _get_task_heartbeats():
    with _task_heartbeats_lock:
        return dict(_task_heartbeats)

# Cooldown for the Players tab's manual Force Sync button - protects the
# Rust server's SSH connection from being hammered if someone double-clicks
# or mashes the button, since each click does a real pull+push for both
# notes and stats. Tracked server-side (not just disabled client-side) so
# it's still enforced even with multiple browser tabs/admins hitting it.
FORCE_SYNC_COOLDOWN_SECONDS = 10
_last_force_sync_at = 0.0
_force_sync_lock = threading.Lock()


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config_fields(updates):
    """Merges `updates` into config.json, leaving every other field (API
    keys, etc.) untouched. Same atomic tmp-file + os.replace pattern as
    player_notes.py's _save, to avoid ever leaving config.json half-written."""
    cfg = load_config()
    cfg.update(updates)
    tmp_path = CONFIG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp_path, CONFIG_PATH)


def get_rcon_client():
    global _rcon_client
    with _rcon_client_lock:
        if _rcon_client is None:
            cfg = load_config()
            logger.info("RCON: connecting to %s:%s", cfg["rcon_host"], cfg["rcon_port"])
            _rcon_client = RconClient(cfg["rcon_host"], cfg["rcon_port"], cfg["rcon_password"])
        return _rcon_client


def reset_rcon_client():
    global _rcon_client
    with _rcon_client_lock:
        if _rcon_client is not None:
            _rcon_client.close()
            logger.warning("RCON: connection reset (will reconnect on next request)")
        _rcon_client = None


# Pending "a player with existing notes just reconnected" alerts, drained
# by the frontend's periodic /api/players/join-alerts poll (piggybacked
# onto refreshStatus() in app.js, not its own fast poll - this is sourced
# from a 60s-interval background tick, so polling it any faster wouldn't
# surface anything sooner). Capped so a long stretch with no one looking
# at the dashboard can't grow this unbounded.
_join_alerts_lock = threading.Lock()
_pending_join_alerts = []
MAX_PENDING_JOIN_ALERTS = 50


def _queue_join_alert(steamid, name, note_count):
    with _join_alerts_lock:
        _pending_join_alerts.append({"steamid": steamid, "name": name, "note_count": note_count})
        del _pending_join_alerts[:-MAX_PENDING_JOIN_ALERTS]


def _drain_join_alerts():
    with _join_alerts_lock:
        alerts = list(_pending_join_alerts)
        _pending_join_alerts.clear()
    return alerts


# The surface a module's register(app, core)/preflight(core) gets handed -
# deliberately a small, explicit set rather than "here's the whole app.py
# module," so it's obvious at a glance what a module can and can't touch.
core = types.SimpleNamespace(
    app=app,
    sock=sock,
    logger=logger,
    load_config=load_config,
    save_config_fields=save_config_fields,
    get_rcon_client=get_rcon_client,
    reset_rcon_client=reset_rcon_client,
    RconError=RconError,
    queue_join_alert=_queue_join_alert,
    get_task_heartbeats=_get_task_heartbeats,
    process_start=_process_start,
)

loaded_modules, skipped_modules = module_loader.discover(VERSION)
core.loaded_modules = loaded_modules
core.skipped_modules = skipped_modules
for _mod in loaded_modules:
    _mod.package.register(app, core)
    logger.info("Module loaded: %s (%s)", _mod.key, _mod.label)
for _key, _reason in skipped_modules:
    logger.warning("Module skipped: %s - %s", _key, _reason)
module_loader.register_static_route(app)


@app.route("/api/modules")
def api_modules():
    """Powers Settings > Module Settings - what's installed, plus a status
    string for anything that didn't load (e.g. needs a newer core version)."""
    return jsonify({
        "loaded": [
            {
                "key": m.key,
                "label": m.label,
                "description": m.description,
                "has_settings": bool(m.manifest.get("settings_panel")),
                "has_preflight": m.has_preflight(),
            }
            for m in loaded_modules
        ],
        "skipped": [{"key": key, "reason": reason} for key, reason in skipped_modules],
    })


@app.route("/api/modules/<module_key>/preflight")
def api_module_preflight(module_key):
    module = next((m for m in loaded_modules if m.key == module_key), None)
    if module is None:
        return jsonify({"error": "Unknown module"}), 404
    return jsonify(module.run_preflight(core))


@app.errorhandler(Exception)
def handle_unhandled_exception(exc):
    # Let Flask's normal 404/405/etc. handling through unchanged - only log
    # genuinely unexpected bugs, not routine "no such route" type errors.
    if isinstance(exc, HTTPException):
        return exc
    logger.exception("Unhandled error in %s %s", request.method, request.path)
    return jsonify({"error": "Internal server error"}), 500


@app.route("/")
def index():
    cfg = load_config()
    # Rendered straight into the page rather than fetched after load, so the
    # inline <head> script (see index.html) can apply it before first paint
    # with no flash of the default theme and no dependency on localStorage -
    # this is what makes a saved theme survive a relaunch in any browser.
    theme_vars_json = json.dumps(cfg.get("theme_vars") or {})

    # Each loaded module contributes its own tab button/panel/settings-panel
    # markup (rendered through Flask's own Jinja env, so url_for etc. work
    # inside them) plus a <script> tag for its JS - assembled here instead
    # of core's templates/JS needing to know which modules exist.
    module_tab_buttons = [m.render_fragment("tab_button") for m in loaded_modules]
    module_tab_panels = [m.render_fragment("tab_panel") for m in loaded_modules]
    module_settings_panels = [
        {"key": m.key, "label": m.label, "html": m.render_fragment("settings_panel")}
        for m in loaded_modules if m.manifest.get("settings_panel")
    ]
    module_scripts = [url for m in loaded_modules for url in m.script_urls()]
    module_styles = [url for m in loaded_modules for url in m.style_urls()]
    # Module Settings is worth showing even for a module with no settings
    # form of its own (e.g. Terminal) - it's still the only place an admin
    # can see "this module is actually loaded" or "this one was skipped."
    show_module_settings = bool(loaded_modules or skipped_modules)

    return render_template(
        "index.html",
        version=VERSION,
        theme_vars_json=theme_vars_json,
        show_module_settings=show_module_settings,
        module_tab_buttons=module_tab_buttons,
        module_tab_panels=module_tab_panels,
        module_settings_panels=module_settings_panels,
        module_scripts=module_scripts,
        module_styles=module_styles,
    )


@app.route("/api/settings/theme")
def api_settings_theme_get():
    cfg = load_config()
    return jsonify({
        "theme_preset_key": cfg.get("theme_preset_key"),
        "theme_vars": cfg.get("theme_vars") or {},
    })


@app.route("/api/settings/theme", methods=["POST"])
def api_settings_theme_set():
    body = request.get_json(force=True) or {}
    preset_key = body.get("theme_preset_key")
    theme_vars = body.get("theme_vars")
    if not isinstance(theme_vars, dict):
        return jsonify({"error": "theme_vars must be an object"}), 400

    save_config_fields({"theme_preset_key": preset_key, "theme_vars": theme_vars})
    logger.info("Settings: theme saved (preset=%s)", preset_key or "custom")
    return jsonify({"ok": True})


@app.route("/api/settings/notifications")
def api_settings_notifications_get():
    cfg = load_config()
    return jsonify({
        "tour_dismissed": cfg.get("tour_dismissed", False),
        "sound_alerts_enabled": cfg.get("sound_alerts_enabled", True),
    })


@app.route("/api/settings/notifications", methods=["POST"])
def api_settings_notifications_set():
    body = request.get_json(force=True) or {}
    save_config_fields({
        "tour_dismissed": bool(body.get("tour_dismissed")),
        "sound_alerts_enabled": bool(body.get("sound_alerts_enabled")),
    })
    logger.info("Settings: notifications saved")
    return jsonify({"ok": True})


@app.route("/api/settings/rcon")
def api_settings_rcon_get():
    cfg = load_config()
    return jsonify({
        "rcon_host": cfg.get("rcon_host", ""),
        "rcon_port": cfg.get("rcon_port", ""),
        "rcon_password": cfg.get("rcon_password", ""),
    })


@app.route("/api/settings/rcon", methods=["POST"])
def api_settings_rcon_set():
    body = request.get_json(force=True) or {}
    host = (body.get("rcon_host") or "").strip()
    port = body.get("rcon_port")
    password = body.get("rcon_password") or ""
    if not host or not password:
        return jsonify({"error": "Host and password are required"}), 400
    try:
        port = int(port)
    except (TypeError, ValueError):
        return jsonify({"error": "Port must be a number"}), 400

    save_config_fields({"rcon_host": host, "rcon_port": port, "rcon_password": password})
    reset_rcon_client()
    logger.info("Settings: RCON target changed to %s:%s", host, port)
    return jsonify({"ok": True})


@app.route("/api/settings/api-keys")
def api_settings_api_keys_get():
    cfg = load_config()
    return jsonify({
        "steam_api_key": cfg.get("steam_api_key", ""),
        "rustmaps_api_key": cfg.get("rustmaps_api_key", ""),
        "battlemetrics_id": cfg.get("battlemetrics_id", ""),
    })


@app.route("/api/settings/api-keys", methods=["POST"])
def api_settings_api_keys_set():
    # All three are optional - the features they power just turn themselves
    # off (already handled by their own "not configured" checks) when one
    # is blank, so unlike RCON, there's nothing here to require non-empty.
    body = request.get_json(force=True) or {}
    steam_api_key = (body.get("steam_api_key") or "").strip()
    rustmaps_api_key = (body.get("rustmaps_api_key") or "").strip()
    battlemetrics_id = (body.get("battlemetrics_id") or "").strip()

    save_config_fields({
        "steam_api_key": steam_api_key,
        "rustmaps_api_key": rustmaps_api_key,
        "battlemetrics_id": battlemetrics_id,
    })
    logger.info("Settings: API keys updated")  # never log the actual key values
    return jsonify({"ok": True})


@app.route("/api/settings/update-check")
def api_settings_update_check():
    try:
        return jsonify(check_for_update(VERSION))
    except Exception as exc:
        logger.warning("Update check failed: %s", exc)
        return jsonify({"error": f"Couldn't check for updates: {exc}"}), 502


@app.route("/api/settings/update-apply", methods=["POST"])
def api_settings_update_apply():
    global VERSION
    project_dir = os.path.join(BASE_DIR, "..")
    try:
        apply_update(project_dir)
    except Exception as exc:
        logger.exception("Update apply failed")
        return jsonify({"error": f"Update failed: {exc}"}), 502

    # VERSION was only ever read once, at process startup - without this,
    # the Update tab (and the footer) would keep showing the old version
    # after a successful apply, even though the files on disk are already
    # current, which looked exactly like the update hadn't done anything.
    # The actual running code is still the old version in memory either
    # way - only this display string can refresh without a real restart.
    try:
        with open(VERSION_PATH, "r", encoding="utf-8") as f:
            VERSION = f.read().strip()
    except OSError:
        pass

    logger.info("Update applied (now v%s on disk) - restart needed to run it", VERSION)
    return jsonify({"ok": True, "new_version": VERSION})


WIPE_FREQUENCIES = {"daily", "biweekly", "monthly"}


@app.route("/api/settings/wipe")
def api_settings_wipe_get():
    cfg = load_config()
    return jsonify({
        "wipe_frequency": cfg.get("wipe_frequency", "monthly"),
        "wipe_time": cfg.get("wipe_time", "14:00"),
        "wipe_timezone": cfg.get("wipe_timezone", "America/Chicago"),
        "wipe_anchor_date": cfg.get("wipe_anchor_date", ""),
    })


@app.route("/api/settings/wipe", methods=["POST"])
def api_settings_wipe_set():
    body = request.get_json(force=True) or {}
    frequency = (body.get("wipe_frequency") or "").strip()
    time_str = (body.get("wipe_time") or "").strip()
    timezone = (body.get("wipe_timezone") or "").strip()
    anchor_date = (body.get("wipe_anchor_date") or "").strip()

    if frequency not in WIPE_FREQUENCIES:
        return jsonify({"error": "Unknown wipe frequency"}), 400
    if not re.match(r"^\d{2}:\d{2}$", time_str):
        return jsonify({"error": "Time must be in HH:MM format"}), 400
    if not timezone:
        return jsonify({"error": "Timezone is required"}), 400
    if frequency == "biweekly" and not re.match(r"^\d{4}-\d{2}-\d{2}$", anchor_date):
        return jsonify({"error": "Bi-weekly needs an anchor date (YYYY-MM-DD)"}), 400

    save_config_fields({
        "wipe_frequency": frequency,
        "wipe_time": time_str,
        "wipe_timezone": timezone,
        "wipe_anchor_date": anchor_date,
    })
    logger.info("Settings: wipe schedule changed to %s %s %s", frequency, time_str, timezone)
    return jsonify({"ok": True})


@app.route("/api/status")
def api_status():
    try:
        client = get_rcon_client()
        client.send_command("echo NOR Dashboard connected", quiet=True)
        return jsonify({"connected": True})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"connected": False, "error": str(exc)})


@app.route("/api/heartbeat", methods=["POST"])
def api_heartbeat():
    """The dashboard page calls this every few seconds for as long as it's
    open - see _heartbeat_watchdog_loop. Unrelated to /api/status above:
    that one's about whether RCON is reachable, this one's about whether
    the browser is still open at all."""
    global _last_heartbeat
    _last_heartbeat = time.time()
    return jsonify({"ok": True})


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    """run.bat calls this before launching a new instance, so a previous
    one that's still alive (closing only starts the up-to-90s heartbeat
    grace period, it doesn't shut anything down immediately) gets replaced
    outright instead of either failing to bind the port or - worse -
    silently leaving you looking at that stale instance the whole time,
    wondering why a just-applied update still shows the old version.
    Exits from a separate thread so this request's own response actually
    makes it back to the caller first."""
    logger.info("Shutting down: a new launch is taking over")
    threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0))).start()
    return jsonify({"ok": True})


@app.route("/api/command", methods=["POST"])
def api_command():
    body = request.get_json(force=True) or {}
    command = (body.get("command") or "").strip()
    if not command:
        return jsonify({"error": "command is required"}), 400
    try:
        response = get_rcon_client().send_command(command)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/console/broadcast", methods=["POST"])
def api_console_broadcast():
    body = request.get_json(force=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        return jsonify({"error": "message is required"}), 400
    try:
        response = broadcast_message(get_rcon_client(), message)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/console/give-item", methods=["POST"])
def api_console_give_item():
    body = request.get_json(force=True) or {}
    steamid = (body.get("steamid") or "").strip()
    shortname = (body.get("shortname") or "").strip()
    amount = body.get("amount")
    if not steamid or not shortname:
        return jsonify({"error": "steamid and shortname are required"}), 400
    try:
        amount = int(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "amount must be a number"}), 400
    if amount < 1:
        return jsonify({"error": "amount must be at least 1"}), 400
    try:
        response = give_item(get_rcon_client(), steamid, shortname, amount)
        logger.info("Gave %s x%s to %s", shortname, amount, steamid)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/items/catalog")
def api_items_catalog():
    return jsonify({"items": ITEM_CATALOG})


@app.route("/api/console/log")
def api_console_log():
    tail = request.args.get("tail")
    if tail is not None:
        try:
            lines, latest = get_log_tail(int(tail))
        except ValueError:
            lines, latest = get_log_tail(20)
    else:
        after = request.args.get("after", "0")
        try:
            after = int(after)
        except ValueError:
            after = 0
        lines, latest = get_log_since(after)
    return jsonify({
        "lines": [{"seq": seq, "timestamp": ts, "message": msg} for seq, ts, msg in lines],
        "latest": latest,
    })


@app.route("/api/players")
def api_players():
    try:
        client = get_rcon_client()
        players, raw, ok = get_players(client)
        banned_ids = get_banned_steamids(client)
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502

    cfg = load_config()
    api_key = cfg.get("steam_api_key", "")
    have_key = bool(api_key) and api_key != "CHANGE_ME"

    steamids = [p.get("SteamID") or p.get("steamid") or "" for p in players]
    steamids = [s for s in steamids if s]
    bans_by_id = {}
    if have_key and steamids:
        try:
            bans_by_id = get_player_bans_cached(api_key, steamids)
        except Exception:
            bans_by_id = {}

    enriched = []
    for p in players:
        steamid = p.get("SteamID") or p.get("steamid") or ""
        stats = get_stats(steamid) if steamid else None
        rust_hours = None
        if have_key and steamid:
            try:
                rust_hours = get_rust_playtime_hours(api_key, steamid)
            except Exception:
                rust_hours = None
        ban_info = bans_by_id.get(steamid) or {}
        enriched.append({
            **p,
            "banned": steamid in banned_ids,
            "rust_hours": rust_hours,
            "last_connected": stats.get("last_connected") if stats else None,
            "total_seconds_on_server": stats.get("total_seconds_on_server") if stats else None,
            "vac_banned": ban_info.get("VACBanned", False),
            "number_of_vac_bans": ban_info.get("NumberOfVACBans", 0),
            "number_of_game_bans": ban_info.get("NumberOfGameBans", 0),
        })

    return jsonify({"players": enriched, "raw": raw, "ok": ok})


@app.route("/api/players/ban", methods=["POST"])
def api_players_ban():
    body = request.get_json(force=True) or {}
    steamid = (body.get("steamid") or "").strip()
    reason = (body.get("reason") or "Banned via NOR Dashboard").strip()
    if not steamid:
        return jsonify({"error": "steamid is required"}), 400
    try:
        response = ban_player(get_rcon_client(), steamid, reason)
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502
    _note_ok, note_error = add_note(get_rcon_client(), steamid, reason, note_type="ban")
    result = {"response": response}
    if note_error:
        result["note_warning"] = f"Ban succeeded, but the ban note couldn't be fully synced: {note_error}"
    return jsonify(result)


@app.route("/api/players/unban", methods=["POST"])
def api_players_unban():
    body = request.get_json(force=True) or {}
    steamid = (body.get("steamid") or "").strip()
    if not steamid:
        return jsonify({"error": "steamid is required"}), 400
    try:
        response = unban_player(get_rcon_client(), steamid)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/players/kick", methods=["POST"])
def api_players_kick():
    body = request.get_json(force=True) or {}
    steamid = (body.get("steamid") or "").strip()
    reason = (body.get("reason") or "").strip()
    if not steamid:
        return jsonify({"error": "steamid is required"}), 400
    try:
        response = kick_player(get_rcon_client(), steamid, reason)
        logger.info("Kicked %s (%s)", steamid, reason or "no reason given")
        _note_ok, note_error = add_note(get_rcon_client(), steamid, reason or "Kicked via NOR Dashboard (no reason given)", note_type="kick")
        result = {"response": response}
        if note_error:
            result["note_warning"] = f"Kick succeeded, but the kick note couldn't be fully synced: {note_error}"
        return jsonify(result)
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/players/notes")
def api_players_notes_get():
    steamid = request.args.get("steamid", "").strip()
    if not steamid:
        return jsonify({"error": "steamid is required"}), 400
    notes, error = get_notes(get_rcon_client(), steamid)
    result = {"notes": notes}
    if error:
        result["sync_warning"] = f"Showing the locally cached notes - couldn't confirm the latest copy from the server: {error}"
    return jsonify(result)


@app.route("/api/players/notes/search")
def api_players_notes_search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "q is required"}), 400
    matches, error = search_notes(get_rcon_client(), query)
    result = {"matches": matches}
    if error:
        result["sync_warning"] = f"Showing locally cached notes - couldn't confirm the latest copy from the server: {error}"
    return jsonify(result)


@app.route("/api/players/notes", methods=["POST"])
def api_players_notes_add():
    body = request.get_json(force=True) or {}
    steamid = (body.get("steamid") or "").strip()
    text = (body.get("text") or "").strip()
    if not steamid or not text:
        return jsonify({"error": "steamid and text are required"}), 400
    ok, error = add_note(get_rcon_client(), steamid, text, note_type="manual")
    result = {"ok": ok}
    if error:
        result["sync_warning"] = error
    return jsonify(result)


@app.route("/api/players/notes", methods=["DELETE"])
def api_players_notes_delete():
    body = request.get_json(force=True) or {}
    steamid = (body.get("steamid") or "").strip()
    index = body.get("index")
    if not steamid or index is None:
        return jsonify({"error": "steamid and index are required"}), 400
    try:
        index = int(index)
    except (TypeError, ValueError):
        return jsonify({"error": "index must be a number"}), 400
    ok, error = delete_note(get_rcon_client(), steamid, index)
    result = {"ok": ok}
    if error:
        if ok:
            result["sync_warning"] = error
        else:
            result["error"] = error
    return jsonify(result)


@app.route("/api/players/sync-now", methods=["POST"])
def api_players_sync_now():
    global _last_force_sync_at
    with _force_sync_lock:
        elapsed = time.time() - _last_force_sync_at
        if elapsed < FORCE_SYNC_COOLDOWN_SECONDS:
            wait_seconds = int(round(FORCE_SYNC_COOLDOWN_SECONDS - elapsed))
            return jsonify({"ok": False, "error": "cooldown", "wait_seconds": max(wait_seconds, 1)}), 429
        _last_force_sync_at = time.time()
    notes_synced, notes_error = force_full_sync(get_rcon_client())
    stats_synced, stats_error = sync_with_remote(get_rcon_client())
    result = {"ok": True, "notes_synced": notes_synced, "stats_synced": stats_synced}
    errors = [e for e in (notes_error, stats_error) if e]
    if errors:
        result["errors"] = errors
    return jsonify(result)


@app.route("/api/players/join-alerts")
def api_players_join_alerts():
    """Drains and returns whatever join alerts _player_tracker_loop has
    queued since the last time this was called - no replay/history like
    the console log's after=seq scheme, since the frontend only ever
    needs "what's new since I last checked"."""
    return jsonify({"alerts": _drain_join_alerts()})


@app.route("/api/players/offline")
def api_players_offline():
    """Recently-seen players who aren't currently connected, most recent
    first, capped to a reasonable number so this doesn't grow forever."""
    try:
        online_players, _raw, _ok = get_players(get_rcon_client())
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502

    online_ids = {p.get("SteamID") or p.get("steamid") for p in online_players}
    all_stats = get_all_stats()

    offline = []
    for steamid, entry in all_stats.items():
        if steamid in online_ids:
            continue
        offline.append({
            "steamid": steamid,
            "name": entry.get("name", ""),
            "ip": entry.get("last_ip", ""),
            "last_connected": entry.get("last_connected"),
            "total_seconds_on_server": entry.get("total_seconds", 0),
        })
    offline.sort(key=lambda p: p.get("last_connected") or "", reverse=True)
    offline = offline[:20]

    cfg = load_config()
    api_key = cfg.get("steam_api_key", "")
    if api_key and api_key != "CHANGE_ME":
        try:
            bans_by_id = get_player_bans_cached(api_key, [p["steamid"] for p in offline])
        except Exception:
            bans_by_id = {}
        for p in offline:
            ban_info = bans_by_id.get(p["steamid"]) or {}
            p["vac_banned"] = ban_info.get("VACBanned", False)
            p["number_of_vac_bans"] = ban_info.get("NumberOfVACBans", 0)
            p["number_of_game_bans"] = ban_info.get("NumberOfGameBans", 0)

    return jsonify({"players": offline})


@app.route("/api/players/banned")
def api_players_banned():
    try:
        banned_ids = get_banned_steamids(get_rcon_client())
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502

    all_stats = get_all_stats()
    banned = [{"steamid": sid, "name": all_stats.get(sid, {}).get("name", "")} for sid in banned_ids]
    banned.sort(key=lambda p: p["name"] or p["steamid"])
    return jsonify({"players": banned})


@app.route("/api/players/online")
def api_players_online():
    """Compact player list (name, avatar, session time) for the Console
    tab's sidebar. Avatars come from the Steam Web API, looked up per
    online player - skipped gracefully if no API key is configured."""
    try:
        players, _raw, ok = get_players(get_rcon_client())
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502

    cfg = load_config()
    api_key = cfg.get("steam_api_key", "")
    have_key = bool(api_key) and api_key != "CHANGE_ME"

    result = []
    for p in players:
        steamid = p.get("SteamID") or p.get("steamid") or ""
        name = p.get("DisplayName") or p.get("Name") or p.get("name") or "Unknown"
        avatar = None
        if have_key and steamid:
            try:
                summary = get_player_summary(api_key, steamid)
                if summary:
                    avatar = summary.get("avatarmedium") or summary.get("avatar")
            except Exception:
                avatar = None
        result.append({
            "steamid": steamid,
            "name": name,
            "connected_seconds": p.get("ConnectedSeconds"),
            "avatar": avatar,
        })
    return jsonify({"players": result, "ok": ok})


@app.route("/api/permissions/grant", methods=["POST"])
def api_grant():
    body = request.get_json(force=True) or {}
    target, permission = body.get("target", "").strip(), body.get("permission", "").strip()
    if not target or not permission:
        return jsonify({"error": "target and permission are required"}), 400
    try:
        response = grant_permission(get_rcon_client(), body.get("target_type", "user"), target, permission)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/permissions/revoke", methods=["POST"])
def api_revoke():
    body = request.get_json(force=True) or {}
    target, permission = body.get("target", "").strip(), body.get("permission", "").strip()
    if not target or not permission:
        return jsonify({"error": "target and permission are required"}), 400
    try:
        response = revoke_permission(get_rcon_client(), body.get("target_type", "user"), target, permission)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/group/add-user", methods=["POST"])
def api_group_add_user():
    body = request.get_json(force=True) or {}
    user, group = body.get("user", "").strip(), body.get("group", "").strip()
    if not user or not group:
        return jsonify({"error": "user and group are required"}), 400
    try:
        response = add_user_to_group(get_rcon_client(), user, group)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/group/remove-user", methods=["POST"])
def api_group_remove_user():
    body = request.get_json(force=True) or {}
    user, group = body.get("user", "").strip(), body.get("group", "").strip()
    if not user or not group:
        return jsonify({"error": "user and group are required"}), 400
    try:
        response = remove_user_from_group(get_rcon_client(), user, group)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/group/create", methods=["POST"])
def api_group_create():
    body = request.get_json(force=True) or {}
    group = body.get("group", "").strip()
    title = body.get("title", "").strip()
    if not group:
        return jsonify({"error": "group is required"}), 400
    try:
        client = get_rcon_client()
        response = create_group(client, group, title)
        client.send_command("server.writecfg")
        logger.info("Permissions: created group '%s'", group)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/group/remove", methods=["POST"])
def api_group_remove():
    body = request.get_json(force=True) or {}
    group = body.get("group", "").strip()
    if not group:
        return jsonify({"error": "group is required"}), 400
    try:
        client = get_rcon_client()
        response = remove_group(client, group)
        client.send_command("server.writecfg")
        logger.info("Permissions: removed group '%s'", group)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/permissions/catalog")
def api_permissions_catalog():
    """Known permission strings, read from the installed plugins' source -
    see permissions_catalog.py for how this list was generated."""
    return jsonify({"permissions": KNOWN_PERMISSIONS})


@app.route("/api/permissions/show")
def api_show():
    target_type = request.args.get("type", "user")
    target = request.args.get("target", "").strip()
    if not target:
        return jsonify({"error": "target is required"}), 400
    try:
        client = get_rcon_client()
        response = show_group(client, target) if target_type == "group" else show_user(client, target)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/groups")
def api_groups():
    """Group names parsed straight from 'oxide.show groups' (not cached),
    so this always reflects what's actually on the server right now,
    including any group just created via /api/group/create."""
    try:
        return jsonify({"names": list_group_names(get_rcon_client())})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/server/info")
def api_server_info():
    try:
        return jsonify(get_server_info(get_rcon_client()))
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/server/entity-history")
def api_server_entity_history():
    return jsonify({"history": get_entity_history()})


@app.route("/api/server/settings", methods=["GET"])
def api_server_settings_get():
    try:
        return jsonify(get_server_settings(get_rcon_client()))
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/server/settings", methods=["POST"])
def api_server_settings_set():
    body = request.get_json(force=True) or {}
    field = body.get("field", "")
    value = (body.get("value") or "").strip()
    convar = SETTING_CONVARS.get(field)
    if not convar:
        return jsonify({"error": f"Unknown field: {field}"}), 400
    if not value:
        return jsonify({"error": "Value cannot be empty"}), 400
    try:
        response = set_convar(get_rcon_client(), convar, value)
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/map/image")
def api_map_image():
    cfg = load_config()
    api_key = cfg.get("rustmaps_api_key", "")
    try:
        return jsonify(get_map_image(get_rcon_client(), api_key))
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"status": "error", "error": str(exc)}), 502


@app.route("/api/map/entities")
def api_map_entities():
    try:
        client = get_rcon_client()
        players, _raw, _ok = get_players(client)
        events = get_world_events(client)
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502

    cfg = load_config()
    api_key = cfg.get("steam_api_key", "")
    have_key = bool(api_key) and api_key != "CHANGE_ME"

    player_markers = []
    for p in players:
        pos = p.get("Position") or {}
        steamid = p.get("SteamID") or p.get("steamid") or ""
        avatar = None
        if have_key and steamid:
            try:
                summary = get_player_summary(api_key, steamid)
                if summary:
                    avatar = summary.get("avatarmedium") or summary.get("avatar")
            except Exception:
                avatar = None
        player_markers.append({
            "name": p.get("DisplayName") or p.get("Name") or p.get("name") or "Unknown",
            "steamid": steamid,
            "avatar": avatar,
            "x": pos.get("x"),
            "z": pos.get("z"),
        })

    event_markers = [{"label": e["label"], "name": e["name"], "x": e["x"], "z": e["z"]} for e in events]
    return jsonify({"players": player_markers, "events": event_markers})


@app.route("/api/battlemetrics/stats")
def api_battlemetrics_stats():
    cfg = load_config()
    return jsonify(get_server_stats(cfg.get("battlemetrics_id", "")))


@app.route("/api/steam/lookup/<steamid>")
def api_steam_lookup(steamid):
    cfg = load_config()
    api_key = cfg.get("steam_api_key", "")
    if not api_key or api_key == "CHANGE_ME":
        return jsonify({"error": "Add your Steam Web API key in Settings > API Keys first"}), 400
    try:
        return jsonify(lookup_player(api_key, steamid))
    except Exception as exc:  # network errors, bad API key, rate limits, etc.
        return jsonify({"error": str(exc)}), 502


def _player_tracker_loop():
    """Runs for the life of the process, independent of whether a browser
    tab is open, so 'last connected' / 'total time on server' keep building
    up even if nobody's looking at the dashboard. Also flags a join alert
    for anyone with existing notes who shows up newly online this tick -
    previously_online_ids starts as None (not an empty set) specifically
    so the very first tick after a restart establishes a baseline instead
    of treating every already-connected noted player as a fresh "just
    reconnected" event."""
    previously_online_ids = None
    while True:
        try:
            players, _raw, ok = get_players(get_rcon_client())
            if ok:
                snapshot = []
                for p in players:
                    steamid = p.get("SteamID") or p.get("steamid") or ""
                    name = p.get("DisplayName") or p.get("Name") or p.get("name") or ""
                    ip = p.get("Address") or p.get("address") or ""
                    if steamid:
                        snapshot.append({"steamid": steamid, "name": name, "ip": ip})
                record_snapshot(snapshot)

                current_ids = {p["steamid"] for p in snapshot}
                if previously_online_ids is not None:
                    for steamid in current_ids - previously_online_ids:
                        name = next((p["name"] for p in snapshot if p["steamid"] == steamid), steamid)
                        try:
                            notes, _error = get_notes(get_rcon_client(), steamid)
                        except Exception:
                            notes = []
                        if notes:
                            _queue_join_alert(steamid, name, len(notes))
                previously_online_ids = current_ids
            _record_task_run("player_tracker")
        except RconError as exc:
            logger.info("Player tracker: RCON unreachable this cycle: %s", exc)
            _record_task_run("player_tracker", "error", f"RCON unreachable: {exc}")
        except Exception:
            # Never let an unexpected error kill this background thread, but
            # do record it - this loop runs silently for the life of the
            # process otherwise, so a bug here would be invisible.
            logger.exception("Player tracker: unexpected error")
            _record_task_run("player_tracker", "error", "unexpected error (see log)")
        time.sleep(60)


def _player_stats_sync_loop():
    """Merges this dashboard's locally-accumulated player stats with
    whatever's on the Rust server (see player_stats.sync_with_remote and
    player_data_sync.py) every few minutes - deliberately not on every
    60s record_snapshot() tick, since that would mean every admin's
    dashboard hitting RCON once a minute just for this. A short initial
    delay, not the full interval, so a freshly-opened dashboard picks up
    other admins' data quickly rather than waiting minutes for the first
    sync. Sync failures land in the log instead of going silent, since
    this loop has no UI to surface them through on its own - the Players
    tab's Force Sync button is what gives an admin an on-demand,
    in-browser version of the same error."""
    time.sleep(15)
    while True:
        try:
            ok, error = sync_with_remote(get_rcon_client())
            if not ok:
                logger.info("Player stats sync: %s", error)
                _record_task_run("player_stats_sync", "error", error or "sync failed")
            else:
                _record_task_run("player_stats_sync")
        except Exception:
            logger.exception("Player stats sync: unexpected error")
            _record_task_run("player_stats_sync", "error", "unexpected error (see log)")
        time.sleep(PLAYER_STATS_SYNC_INTERVAL_SECONDS)


def _entity_history_loop():
    """Samples the server's current EntityCount (from serverinfo) every
    few minutes and records it via entity_history.py, so the Overview
    tab's history graph has something to draw - runs independent of
    whether a browser tab is open, same as the player tracker above."""
    while True:
        try:
            info = get_server_info(get_rcon_client())
            entity_count = info.get("EntityCount")
            if entity_count is not None:
                record_entity_sample(entity_count)
            _record_task_run("entity_history")
        except RconError as exc:
            logger.info("Entity history: RCON unreachable this cycle: %s", exc)
            _record_task_run("entity_history", "error", f"RCON unreachable: {exc}")
        except Exception:
            logger.exception("Entity history: unexpected error")
            _record_task_run("entity_history", "error", "unexpected error (see log)")
        time.sleep(ENTITY_HISTORY_INTERVAL_SECONDS)


def _heartbeat_watchdog_loop():
    """Shuts the whole process down once the browser stops sending
    heartbeats (see /api/heartbeat) - this is what makes closing the
    dashboard's browser window close the dashboard itself, now that it runs
    windowless with no console to close instead. The grace period exists so
    this can't fire before the browser has even had a chance to load the
    page and send its first ping."""
    process_start = _last_heartbeat
    while True:
        time.sleep(WATCHDOG_CHECK_INTERVAL_SECONDS)
        now = time.time()
        if now - process_start < HEARTBEAT_GRACE_SECONDS:
            continue
        if now - _last_heartbeat > HEARTBEAT_TIMEOUT_SECONDS:
            logger.warning("Shutting down: no heartbeat received for over %ds", HEARTBEAT_TIMEOUT_SECONDS)
            os._exit(0)


if __name__ == "__main__":
    logger.info("Starting NOR Dashboard v%s", VERSION)
    threading.Thread(target=_player_tracker_loop, daemon=True).start()
    threading.Thread(target=_player_stats_sync_loop, daemon=True).start()
    threading.Thread(target=_entity_history_loop, daemon=True).start()
    threading.Thread(target=_heartbeat_watchdog_loop, daemon=True).start()
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)

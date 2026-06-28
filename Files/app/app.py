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
from logging.handlers import RotatingFileHandler

from flask import Flask, jsonify, render_template, request
from flask_sock import Sock
from werkzeug.exceptions import HTTPException

import ssh_ws
from amap_commands import AMAP_ACTIONS, run_amap_action
from ban_commands import ban_player, broadcast_message, get_banned_steamids, give_item, kick_player, unban_player
from battlemetrics import get_server_stats
from map_data import get_map_image
from map_entities import get_world_events
from oxide_commands import (
    add_user_to_group,
    create_group,
    grant_permission,
    list_group_names,
    remove_user_from_group,
    revoke_permission,
    show_group,
    show_user,
)
from permissions_catalog import KNOWN_PERMISSIONS
from player_notes import add_note, delete_note, get_notes
from player_stats import get_all_stats, get_stats, record_snapshot, sync_with_remote
from plugin_deploy import list_known_plugin_names, upload_plugin
from rcon_client import RconClient, RconError, get_log_since, get_log_tail, get_players
from server_info import SETTING_CONVARS, get_server_info, get_server_settings, set_convar
from steam_api import get_player_summary, get_rust_playtime_hours, lookup_player
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

sock = Sock(app)
ssh_ws.register(sock)

_rcon_client = None

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
HEARTBEAT_TIMEOUT_SECONDS = 90
HEARTBEAT_GRACE_SECONDS = 30
WATCHDOG_CHECK_INTERVAL_SECONDS = 10
PLAYER_STATS_SYNC_INTERVAL_SECONDS = 300


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
    if _rcon_client is None:
        cfg = load_config()
        logger.info("RCON: connecting to %s:%s", cfg["rcon_host"], cfg["rcon_port"])
        _rcon_client = RconClient(cfg["rcon_host"], cfg["rcon_port"], cfg["rcon_password"])
    return _rcon_client


def reset_rcon_client():
    global _rcon_client
    if _rcon_client is not None:
        _rcon_client.close()
        logger.warning("RCON: connection reset (will reconnect on next request)")
    _rcon_client = None


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
    return render_template("index.html", version=VERSION, theme_vars_json=theme_vars_json)


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


@app.route("/api/settings/plugin-deploy")
def api_settings_plugin_deploy_get():
    cfg = load_config()
    return jsonify({
        "plugin_deploy_host": cfg.get("plugin_deploy_host", ""),
        "plugin_deploy_username": cfg.get("plugin_deploy_username", ""),
        "plugin_deploy_path": cfg.get("plugin_deploy_path", ""),
    })


@app.route("/api/settings/plugin-deploy", methods=["POST"])
def api_settings_plugin_deploy_set():
    body = request.get_json(force=True) or {}
    host = (body.get("plugin_deploy_host") or "").strip()
    username = (body.get("plugin_deploy_username") or "").strip()
    path = (body.get("plugin_deploy_path") or "").strip()
    if not host or not username or not path:
        return jsonify({"error": "Host, username, and path are all required"}), 400

    save_config_fields({
        "plugin_deploy_host": host,
        "plugin_deploy_username": username,
        "plugin_deploy_path": path,
    })
    logger.info("Settings: Plugin Deploy target changed to %s@%s:%s", username, host, path)
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
        enriched.append({
            **p,
            "banned": steamid in banned_ids,
            "rust_hours": rust_hours,
            "last_connected": stats.get("last_connected") if stats else None,
            "total_seconds_on_server": stats.get("total_seconds_on_server") if stats else None,
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
    add_note(steamid, reason, note_type="ban")
    return jsonify({"response": response})


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
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/players/notes")
def api_players_notes_get():
    steamid = request.args.get("steamid", "").strip()
    if not steamid:
        return jsonify({"error": "steamid is required"}), 400
    return jsonify({"notes": get_notes(steamid)})


@app.route("/api/players/notes", methods=["POST"])
def api_players_notes_add():
    body = request.get_json(force=True) or {}
    steamid = (body.get("steamid") or "").strip()
    text = (body.get("text") or "").strip()
    if not steamid or not text:
        return jsonify({"error": "steamid and text are required"}), 400
    add_note(steamid, text, note_type="manual")
    return jsonify({"ok": True})


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
    ok = delete_note(steamid, index)
    return jsonify({"ok": ok})


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
            "last_connected": entry.get("last_connected"),
            "total_seconds_on_server": entry.get("total_seconds", 0),
        })
    offline.sort(key=lambda p: p.get("last_connected") or "", reverse=True)
    return jsonify({"players": offline[:20]})


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


@app.route("/api/amap/actions")
def api_amap_actions():
    actions = [{"key": key, **info} for key, info in AMAP_ACTIONS.items()]
    return jsonify({"actions": actions})


@app.route("/api/amap/run", methods=["POST"])
def api_amap_run():
    body = request.get_json(force=True) or {}
    action = body.get("action", "")
    fields = body.get("fields") or {}
    if action not in AMAP_ACTIONS:
        return jsonify({"error": f"Unknown action: {action}"}), 400
    try:
        response = run_amap_action(get_rcon_client(), action, fields)
        logger.info("AMAP: ran '%s'", action)
        return jsonify({"response": response})
    except RconError as exc:
        logger.warning("AMAP: '%s' failed: %s", action, exc)
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/amap/wipe-config")
def api_amap_wipe_config():
    """Read-only peek at the next wipe's configured seed/size/type/date -
    separate from the regular whitelist since it's tied to one specific
    card (Wipe Configurator) rather than being its own button."""
    try:
        response = get_rcon_client().send_command("amap.run wipe_configure_view")
        return jsonify({"response": response})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502


@app.route("/api/amap/plugins")
def api_amap_plugins():
    """Currently-installed plugin names, for the upload panel's informational
    dropdown - parsed from RCON's own oxide.plugins output rather than an
    SFTP directory listing, since that's already proven reliable here."""
    try:
        raw = get_rcon_client().send_command("oxide.plugins", quiet=True)
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"error": str(exc)}), 502
    return jsonify({"plugins": list_known_plugin_names(raw)})


@app.route("/api/amap/upload-plugin", methods=["POST"])
def api_amap_upload_plugin():
    cfg = load_config()
    host = cfg.get("plugin_deploy_host", "")
    username = cfg.get("plugin_deploy_username", "")
    path = cfg.get("plugin_deploy_path", "")
    if not host or host == "CHANGE_ME" or not username or username == "CHANGE_ME" or not path or path == "CHANGE_ME":
        return jsonify({"error": "Set up Plugin Deploy in Settings first"}), 400

    file = request.files.get("plugin")
    if not file or not file.filename:
        return jsonify({"error": "No file selected"}), 400

    ok, message, added = upload_plugin(host, username, path, file.filename, file.read())
    if not ok:
        logger.warning("AMAP: plugin upload of '%s' failed: %s", file.filename, message)
        return jsonify({"error": message}), 502
    logger.info("AMAP: uploaded plugin '%s'%s", file.filename, f" (new permissions: {', '.join(added)})" if added else "")
    return jsonify({"ok": True, "message": message, "added_permissions": added})


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
    up even if nobody's looking at the dashboard."""
    while True:
        try:
            players, _raw, ok = get_players(get_rcon_client())
            if ok:
                snapshot = []
                for p in players:
                    steamid = p.get("SteamID") or p.get("steamid") or ""
                    name = p.get("DisplayName") or p.get("Name") or p.get("name") or ""
                    if steamid:
                        snapshot.append({"steamid": steamid, "name": name})
                record_snapshot(snapshot)
        except RconError as exc:
            logger.info("Player tracker: RCON unreachable this cycle: %s", exc)
        except Exception:
            # Never let an unexpected error kill this background thread, but
            # do record it - this loop runs silently for the life of the
            # process otherwise, so a bug here would be invisible.
            logger.exception("Player tracker: unexpected error")
        time.sleep(60)


def _player_stats_sync_loop():
    """Merges this dashboard's locally-accumulated player stats with
    whatever's on the Rust server (see player_stats.sync_with_remote and
    player_data_sync.py) every few minutes - deliberately not on every
    60s record_snapshot() tick, since that would mean every admin's
    dashboard hitting SFTP once a minute. A short initial delay, not the
    full interval, so a freshly-opened dashboard picks up other admins'
    data quickly rather than waiting minutes for the first sync. A no-op
    (silently) if Plugin Deploy isn't configured."""
    time.sleep(15)
    while True:
        try:
            sync_with_remote()
        except Exception:
            logger.exception("Player stats sync: unexpected error")
        time.sleep(PLAYER_STATS_SYNC_INTERVAL_SECONDS)


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
    threading.Thread(target=_heartbeat_watchdog_loop, daemon=True).start()
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)

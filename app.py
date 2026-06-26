"""
NOR Dashboard - a simple admin dashboard for a Rust server.
Talks to the server over WebRcon and to the Steam Web API for player lookups.
Runs locally only (127.0.0.1) since config.json holds the RCON password.
"""
import json
import os
import threading
import time

from flask import Flask, jsonify, render_template, request

from amap_commands import AMAP_ACTIONS, run_amap_action
from ban_commands import ban_player, get_banned_steamids, unban_player
from map_data import get_map_image
from map_entities import get_world_events
from oxide_commands import (
    add_user_to_group,
    grant_permission,
    list_groups,
    remove_user_from_group,
    revoke_permission,
    show_group,
    show_user,
)
from permissions_catalog import KNOWN_PERMISSIONS
from player_notes import add_note, delete_note, get_notes
from player_stats import get_all_stats, get_stats, record_snapshot
from rcon_client import RconClient, RconError, get_log_since, get_log_tail, get_players
from server_info import SETTING_CONVARS, get_server_info, get_server_settings, set_convar
from steam_api import get_player_summary, get_rust_playtime_hours, lookup_player

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

app = Flask(__name__)
# Without this, Flask only reads templates/index.html once per process start
# and caches it in memory - any wording/HTML edit needs a full restart to
# show up otherwise. This makes it check the file's timestamp every render.
app.config["TEMPLATES_AUTO_RELOAD"] = True

_rcon_client = None


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def get_rcon_client():
    global _rcon_client
    if _rcon_client is None:
        cfg = load_config()
        _rcon_client = RconClient(cfg["rcon_host"], cfg["rcon_port"], cfg["rcon_password"])
    return _rcon_client


def reset_rcon_client():
    global _rcon_client
    if _rcon_client is not None:
        _rcon_client.close()
    _rcon_client = None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    try:
        client = get_rcon_client()
        client.send_command("echo NOR Dashboard connected", quiet=True)
        return jsonify({"connected": True})
    except RconError as exc:
        reset_rcon_client()
        return jsonify({"connected": False, "error": str(exc)})


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
    try:
        return jsonify({"response": list_groups(get_rcon_client())})
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
        return jsonify({"response": response})
    except RconError as exc:
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


@app.route("/api/steam/lookup/<steamid>")
def api_steam_lookup(steamid):
    cfg = load_config()
    api_key = cfg.get("steam_api_key", "")
    if not api_key or api_key == "CHANGE_ME":
        return jsonify({"error": "Add your Steam Web API key to config.json first (see README.md)"}), 400
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
        except RconError:
            pass  # server unreachable this cycle - try again next time
        except Exception:
            pass  # never let an unexpected error kill this background thread
        time.sleep(60)


if __name__ == "__main__":
    threading.Thread(target=_player_tracker_loop, daemon=True).start()
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)

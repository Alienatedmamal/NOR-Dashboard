"""
BattleMetrics server stats for the Overview tab - public, unauthenticated
API (no key needed), looked up by the server's BattleMetrics ID
(battlemetrics_id in config.json - find it in the URL of your server's
page on battlemetrics.com).

Cached briefly since BattleMetrics' own crawler only refreshes a server's
data every minute or so anyway - polling it faster than that just adds
load without getting fresher data.
"""
import time

import requests

API_BASE = "https://api.battlemetrics.com"
_CACHE_SECONDS = 30
_cache = {}


def get_server_stats(battlemetrics_id):
    """Returns a dict with rank, players, maxPlayers, queued, status, and
    a few rust-specific details (fps, uptime, description) - or
    {"error": ...} if the ID is missing or the lookup fails."""
    if not battlemetrics_id or battlemetrics_id == "CHANGE_ME":
        return {"error": "No battlemetrics_id configured"}

    cached = _cache.get(battlemetrics_id)
    if cached and (time.time() - cached["fetched_at"]) < _CACHE_SECONDS:
        return cached["data"]

    try:
        resp = requests.get(f"{API_BASE}/servers/{battlemetrics_id}", timeout=10)
        resp.raise_for_status()
        attrs = resp.json()["data"]["attributes"]
        details = attrs.get("details", {})
        result = {
            "name": attrs.get("name"),
            "rank": attrs.get("rank"),
            "status": attrs.get("status"),
            "players": attrs.get("players"),
            "max_players": attrs.get("maxPlayers"),
            "queued_players": details.get("rust_queued_players"),
            "fps": details.get("rust_fps"),
            "fps_avg": details.get("rust_fps_avg"),
            "uptime": details.get("rust_uptime"),
            "description": details.get("rust_description"),
        }
    except Exception as exc:
        return {"error": str(exc)}

    _cache[battlemetrics_id] = {"fetched_at": time.time(), "data": result}
    return result

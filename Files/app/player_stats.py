"""
Local tracking of player connection history.

Vanilla RCON only tells you who's online *right now* - it has no concept of
"last connected" or cumulative playtime on this particular server. This
module fills that gap itself: something calls record_snapshot() with the
current online player list on a regular interval (see the background
thread in app.py), and it works out who connected/disconnected since the
last snapshot, accumulating totals in player_stats.json next to this file.

This is a polling-based approximation, not an exact log - a session shorter
than the polling interval could be missed. Good enough for "who's been on
and for how long" at a glance, not a forensic record.
"""
import json
import os
import threading
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATS_PATH = os.path.join(BASE_DIR, "player_stats.json")

_lock = threading.Lock()


def _now():
    return datetime.now(timezone.utc)


def _now_iso():
    return _now().isoformat(timespec="seconds")


def _load():
    if not os.path.exists(STATS_PATH):
        return {}
    try:
        with open(STATS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return {}


def _save(data):
    tmp_path = STATS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, STATS_PATH)


def record_snapshot(online_players):
    """online_players: list of {"steamid": ..., "name": ...} for everyone
    currently connected. Called periodically by the background tracker."""
    with _lock:
        data = _load()
        now_iso = _now_iso()
        online_ids = set()

        for p in online_players:
            steamid = p.get("steamid")
            if not steamid:
                continue
            online_ids.add(steamid)
            entry = data.setdefault(steamid, {"name": "", "total_seconds": 0})
            entry["name"] = p.get("name") or entry.get("name", "")
            entry["last_connected"] = now_iso
            if not entry.get("currently_online_since"):
                entry["currently_online_since"] = now_iso

        # Tracked as online in the last snapshot but missing from this one
        # means they disconnected since then - bank their session time.
        for steamid, entry in data.items():
            if steamid in online_ids:
                continue
            since = entry.get("currently_online_since")
            if since:
                try:
                    started = datetime.fromisoformat(since)
                    elapsed = max(0, int((_now() - started).total_seconds()))
                    entry["total_seconds"] = entry.get("total_seconds", 0) + elapsed
                except ValueError:
                    pass
                entry["currently_online_since"] = None

        _save(data)


def get_stats(steamid):
    """Returns {"last_connected": iso_str_or_None, "total_seconds_on_server": int}
    or None if this SteamID has never been seen."""
    with _lock:
        entry = _load().get(steamid)
    if not entry:
        return None
    total_seconds = entry.get("total_seconds", 0)
    since = entry.get("currently_online_since")
    if since:
        try:
            started = datetime.fromisoformat(since)
            total_seconds += max(0, int((_now() - started).total_seconds()))
        except ValueError:
            pass
    return {
        "last_connected": entry.get("last_connected"),
        "total_seconds_on_server": total_seconds,
    }


def get_all_stats():
    """Returns the raw {steamid: entry} map for every player ever seen -
    used to build the offline/banned player lists."""
    with _lock:
        return _load()

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

Also synced to the Rust server itself (see player_data_sync.py) so other
admins running their own copy of this dashboard see the same totals -
unlike player_notes.py, this does NOT pull/push on every single
record_snapshot() call (that runs every 60s; hammering the RCON
connection that often, from every admin's dashboard at once, is the kind
of server load this project has specifically tried to avoid elsewhere).
Instead, a separate,
much slower background loop (see sync_with_remote() and app.py) merges
the local accumulation with whatever's on the server every few minutes.
Merging (not overwriting either way) matters because multiple admins'
dashboards are all independently watching the same online players at the
same time - summing would double-count a session several dashboards
all saw happen once; taking the max of each player's total instead just
keeps whichever dashboard happened to track more of it.
"""
import json
import os
import threading
from datetime import datetime, timezone

import player_data_sync

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATS_PATH = os.path.join(BASE_DIR, "player_stats.json")
STATS_FILENAME = "DB-player_stats.json"

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
    """online_players: list of {"steamid": ..., "name": ..., "ip": ...} for
    everyone currently connected. Called periodically by the background
    tracker."""
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
            if p.get("ip"):
                entry["last_ip"] = p.get("ip")
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


def _merge_entries(local_entry, remote_entry):
    merged = dict(remote_entry)
    merged["name"] = local_entry.get("name") or remote_entry.get("name", "")
    merged["last_ip"] = local_entry.get("last_ip") or remote_entry.get("last_ip", "")
    merged["total_seconds"] = max(local_entry.get("total_seconds", 0), remote_entry.get("total_seconds", 0))
    timestamps = [t for t in (local_entry.get("last_connected"), remote_entry.get("last_connected")) if t]
    merged["last_connected"] = max(timestamps) if timestamps else None
    # Whether THIS dashboard's own tracker currently sees them connected is
    # locally-known information the remote copy (written by some other
    # admin's dashboard, or by this one a few minutes ago) has no way to
    # know about, so prefer the local value here rather than the remote's.
    merged["currently_online_since"] = local_entry.get("currently_online_since") or remote_entry.get("currently_online_since")
    return merged


def sync_with_remote(client):
    """Pulls the server's copy, merges it with whatever this dashboard has
    accumulated locally since the last sync, pushes the merged result back,
    and updates the local cache to match - called periodically by app.py,
    not on every record_snapshot() (see module docstring for why), and also
    on demand by the Players tab's Force Sync button. A no-op if the pull
    fails for any reason - never overwrites the remote with a stale/partial
    local view. Returns (ok, error), so on-demand callers can tell the user
    why the remote was unreachable instead of just that it was."""
    with _lock:
        local = _load()
        remote, ok, error = player_data_sync.pull_json(client, STATS_FILENAME)
        if not ok:
            return False, error
        merged = dict(remote)
        for steamid, local_entry in local.items():
            merged[steamid] = _merge_entries(local_entry, remote.get(steamid, {}))
        _save(merged)
        push_ok, push_error = player_data_sync.push_json(client, STATS_FILENAME, merged)
        if not push_ok:
            return False, f"Pulled and merged, but didn't sync back to the server: {push_error}"
        return True, None

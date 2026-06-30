"""
Tracks the Rust server's entity count over time so the Overview tab can
show a history graph instead of just the current snapshot - entity count
(not player count) is what actually drives world simulation cost, and it
builds up gradually between wipes.

Local-only, not synced to the Rust server like player_notes/player_stats -
this is the same server-wide number no matter which admin's dashboard
observes it, so there's no merge-across-admins need; a dashboard that
wasn't running for a while just has a gap for that stretch.
"""
import json
import os
import threading
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(BASE_DIR, "entity_history.json")

# At the 5-minute sampling interval used by app.py's background loop, this
# is a little over a week of history - small enough as plain JSON to never
# be worth pruning more aggressively than just dropping the oldest points.
MAX_SAMPLES = 2016

_lock = threading.Lock()


def _load():
    if not os.path.exists(HISTORY_PATH):
        return []
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return []


def _save(data):
    tmp_path = HISTORY_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, HISTORY_PATH)


def record_sample(entity_count, player_count=None, queue_count=None, framerate=None):
    with _lock:
        data = _load()
        sample = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "entity_count": entity_count,
        }
        if player_count is not None:
            sample["player_count"] = int(player_count)
        if queue_count is not None:
            sample["queue_count"] = int(queue_count)
        if framerate is not None:
            sample["framerate"] = round(float(framerate), 1)
        data.append(sample)
        if len(data) > MAX_SAMPLES:
            data = data[-MAX_SAMPLES:]
        _save(data)


def get_history():
    with _lock:
        return _load()

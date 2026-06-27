"""
Free-form notes per player - ban reasons land here automatically, and
admins can add their own manual notes too. Persisted in player_notes.json
next to this file, as a list of notes per SteamID (not just one), since a
player's history can have more than one entry over time.
"""
import json
import os
import threading
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NOTES_PATH = os.path.join(BASE_DIR, "player_notes.json")

_lock = threading.Lock()


def _load():
    if not os.path.exists(NOTES_PATH):
        return {}
    try:
        with open(NOTES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return {}


def _save(data):
    tmp_path = NOTES_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, NOTES_PATH)


def add_note(steamid, text, note_type="manual"):
    if not steamid or not text:
        return
    with _lock:
        data = _load()
        notes = data.setdefault(steamid, [])
        notes.append({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "type": note_type,
            "text": text,
        })
        _save(data)


def get_notes(steamid):
    with _lock:
        return _load().get(steamid, [])


def delete_note(steamid, index):
    """Removes the note at position `index` in this player's note list -
    the same order get_notes() returns them in (oldest first). Returns
    False if there was nothing at that index to delete."""
    with _lock:
        data = _load()
        notes = data.get(steamid)
        if not notes or index < 0 or index >= len(notes):
            return False
        notes.pop(index)
        if notes:
            data[steamid] = notes
        else:
            del data[steamid]
        _save(data)
        return True

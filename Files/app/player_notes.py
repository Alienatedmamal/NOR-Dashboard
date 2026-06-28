"""
Free-form notes per player - ban reasons land here automatically, and
admins can add their own manual notes too. Persisted in player_notes.json
next to this file, as a list of notes per SteamID (not just one), since a
player's history can have more than one entry over time.

Also synced to the Rust server itself (see player_data_sync.py) so other
admins running their own copy of this dashboard see the same notes -
every read/write here pulls the latest remote copy first (so it reflects
whatever other admins have added since this dashboard last checked),
applies its own change, then pushes the result back. player_notes.json
becomes a local cache/fallback for whenever the remote isn't reachable,
not the source of truth on its own anymore.
"""
import json
import os
import threading
from datetime import datetime, timezone

import player_data_sync

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NOTES_PATH = os.path.join(BASE_DIR, "player_notes.json")
NOTES_FILENAME = "DB-player_notes.json"

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


def _load_latest():
    """The remote copy if reachable (and keeps the local cache fresh while
    we're at it), otherwise the local cache as a fallback."""
    data, ok = player_data_sync.pull_json(NOTES_FILENAME)
    if ok:
        _save(data)
        return data
    return _load()


def force_full_sync():
    """Pulls the full remote notes file and refreshes the local cache with
    it - used by the Players tab's Force Sync button. Every read already
    pulls fresh (see _load_latest), so this exists mainly to give that
    button a clear yes/no on whether the remote was actually reachable,
    and to keep the local fallback cache current even if no one happens
    to load a specific player's notes right afterward."""
    data, ok = player_data_sync.pull_json(NOTES_FILENAME)
    if ok:
        _save(data)
    return ok


def search_notes(query):
    """Searches every player's notes for `query` (case-insensitive
    substring match against the note text) - lets an admin spot a pattern
    (e.g. "cheating") across everyone instead of needing a SteamID first.
    Returns matches newest-first."""
    query = (query or "").strip().lower()
    if not query:
        return []
    with _lock:
        data = _load_latest()
    matches = [
        {"steamid": steamid, "timestamp": note.get("timestamp"), "type": note.get("type"), "text": note.get("text")}
        for steamid, notes in data.items()
        for note in notes
        if query in (note.get("text") or "").lower()
    ]
    matches.sort(key=lambda m: m.get("timestamp") or "", reverse=True)
    return matches


def add_note(steamid, text, note_type="manual"):
    if not steamid or not text:
        return
    with _lock:
        data = _load_latest()
        notes = data.setdefault(steamid, [])
        notes.append({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "type": note_type,
            "text": text,
        })
        _save(data)
        player_data_sync.push_json(NOTES_FILENAME, data)


def get_notes(steamid):
    with _lock:
        return _load_latest().get(steamid, [])


def delete_note(steamid, index):
    """Removes the note at position `index` in this player's note list -
    the same order get_notes() returns them in (oldest first). Returns
    False if there was nothing at that index to delete."""
    with _lock:
        data = _load_latest()
        notes = data.get(steamid)
        if not notes or index < 0 or index >= len(notes):
            return False
        notes.pop(index)
        if notes:
            data[steamid] = notes
        else:
            del data[steamid]
        _save(data)
        player_data_sync.push_json(NOTES_FILENAME, data)
        return True

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
import secrets
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


def _pull_latest(client):
    """Pulls the remote copy and refreshes the local cache. Returns (data, error).
    Must be called WITHOUT holding _lock - performs network I/O."""
    data, ok, error = player_data_sync.pull_json(client, NOTES_FILENAME)
    if ok:
        with _lock:
            _save(data)
        return data, None
    with _lock:
        return _load(), error


def force_full_sync(client):
    """Pulls the full remote notes file and refreshes the local cache with
    it - used by the Players tab's Force Sync button. Every read already
    pulls fresh (see _pull_latest), so this exists mainly to give that
    button a clear yes/no on whether the remote was actually reachable,
    and to keep the local fallback cache current even if no one happens
    to load a specific player's notes right afterward. Returns (ok, error)."""
    data, ok, error = player_data_sync.pull_json(client, NOTES_FILENAME)
    if ok:
        with _lock:
            _save(data)
    return ok, error


def search_notes(client, query):
    """Searches every player's notes for `query` (case-insensitive
    substring match against the note text) - lets an admin spot a pattern
    (e.g. "cheating") across everyone instead of needing a SteamID first.
    Returns (matches, error), matches newest-first."""
    query = (query or "").strip().lower()
    if not query:
        return [], None
    data, error = _pull_latest(client)
    matches = [
        {"steamid": steamid, "timestamp": note.get("timestamp"), "type": note.get("type"), "text": note.get("text")}
        for steamid, notes in data.items()
        for note in notes
        if query in (note.get("text") or "").lower()
    ]
    matches.sort(key=lambda m: m.get("timestamp") or "", reverse=True)
    return matches, error


def add_note(client, steamid, text, note_type="manual", added_by=""):
    """Returns (ok, error). ok is True as long as the note was saved
    locally - error is only about whether it also made it to the remote
    server, since a failed push still leaves the note safe in the local
    cache (it'll go out on the next successful sync)."""
    if not steamid or not text:
        return False, "Missing steamid or text"
    data, pull_error = _pull_latest(client)
    with _lock:
        notes = data.setdefault(steamid, [])
        entry = {
            "id": secrets.token_hex(8),
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "type": note_type,
            "text": text,
        }
        if added_by:
            entry["added_by"] = added_by
        notes.append(entry)
        _save(data)
    push_ok, push_error = player_data_sync.push_json(client, NOTES_FILENAME, data)
    if not push_ok:
        return True, f"Note saved locally, but didn't sync to the server: {push_error}"
    if pull_error:
        return True, f"Note saved and synced, but the latest remote copy couldn't be confirmed first: {pull_error}"
    return True, None


def get_notes(client, steamid):
    """Returns (notes, error)."""
    data, error = _pull_latest(client)
    return data.get(steamid, []), error


def delete_note(client, steamid, note_id):
    """Removes the note identified by `note_id` (the stable string ID stored
    on each note when it is created). Falls back to treating note_id as a
    numeric list index for notes written before stable IDs were added.
    Returns (ok, error) - ok is False if no matching note was found; error
    covers a failed remote push the same way add_note does."""
    data, pull_error = _pull_latest(client)
    with _lock:
        notes = data.get(steamid)
        if not notes:
            return False, "No note found"
        idx = next((i for i, n in enumerate(notes) if n.get("id") == note_id), None)
        if idx is None:
            try:
                idx = int(note_id)
                if idx < 0 or idx >= len(notes):
                    idx = None
            except (TypeError, ValueError):
                idx = None
        if idx is None:
            return False, "No note found with that ID"
        notes.pop(idx)
        if notes:
            data[steamid] = notes
        else:
            del data[steamid]
        _save(data)
    push_ok, push_error = player_data_sync.push_json(client, NOTES_FILENAME, data)
    if not push_ok:
        return True, f"Note deleted locally, but didn't sync to the server: {push_error}"
    if pull_error:
        return True, f"Note deleted and synced, but the latest remote copy couldn't be confirmed first: {pull_error}"
    return True, None

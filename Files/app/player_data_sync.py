"""
Syncs player_notes.json/player_stats.json to the Rust server itself, so
every admin running their own copy of this dashboard sees the same notes
and stats instead of each having their own disconnected local copy.

Goes over RCON now (the standalone PlayerDataBridge plugin's get_*/set_*
actions - see the playersstats module's AMAP/Plugins/PlayerDataBridge.cs),
not SSH/SFTP and not AmapBridge. Originally used Plugin Deploy's SSH
credentials, but that meant a missing or misconfigured SSH key silently
broke this feature for an admin who otherwise had a fully working
dashboard - RCON access is already a hard requirement for the dashboard
to do anything at all, so reusing it here means no separate setup step
can be missed. Switched off AmapBridge (which this used briefly) since
that plugin's whole dispatch table is gated on an AMAP license - this
sync is meant to work independently of whether someone has AMAP at all,
so it needed its own standalone, separately-licensed plugin. Writes are
base64-encoded before being sent, since RCON commands are parsed as
whitespace-separated arguments - base64 has none, so the JSON's own
quotes/braces/newlines never have to survive that parsing intact.
"""
import base64
import json

from rcon_client import RconError

_FILE_KEYS = {
    "DB-player_notes.json": "notes",
    "DB-player_stats.json": "stats",
}


def pull_json(client, filename):
    """Returns (data, ok, error). ok is False if the read failed for any
    reason - callers should fall back to their own local cache and skip
    pushing back in that case, rather than risk overwriting real remote
    data with an empty/partial result. error is a human-readable reason,
    None on success. A file that's never been synced before is NOT a
    failure - that's just an empty {} with ok=True (PlayerDataBridge
    replies with a literal "{}" for a file that doesn't exist yet)."""
    key = _FILE_KEYS.get(filename)
    if not key:
        return {}, False, f"Unknown sync file: {filename}"
    try:
        raw = client.send_command(f"playerdata.run get_{key}", quiet=True)
    except RconError as exc:
        return {}, False, f"Couldn't reach the Rust server: {exc}"
    if raw.startswith("ERROR:"):
        return {}, False, raw[len("ERROR:"):].strip()
    if not raw.strip():
        return {}, False, "The server sent back an empty response - is PlayerDataBridge up to date and loaded?"
    try:
        return json.loads(raw), True, None
    except ValueError as exc:
        return {}, False, f"The server's response wasn't valid JSON ({exc}) - is PlayerDataBridge up to date?"


def push_json(client, filename, data):
    """Writes `data` to the server over RCON. Returns (ok, error)."""
    key = _FILE_KEYS.get(filename)
    if not key:
        return False, f"Unknown sync file: {filename}"
    try:
        encoded = base64.b64encode(json.dumps(data).encode("utf-8")).decode("ascii")
        response = client.send_command(f"playerdata.run set_{key} {encoded}", quiet=True)
    except RconError as exc:
        return False, f"Couldn't reach the Rust server: {exc}"
    if response.strip().startswith("ERROR:"):
        return False, response.strip()[len("ERROR:"):].strip()
    return True, None

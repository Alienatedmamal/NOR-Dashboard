"""
Syncs player_notes.json/player_stats.json to the Rust server itself
(AMAP/Files/Config/DB-player_notes.json, DB-player_stats.json) over SFTP,
so every admin running their own copy of this dashboard sees the same
notes and stats instead of each having their own disconnected local copy.

Reuses Settings > Plugin Deploy's SSH credentials (paramiko, key-based
auth, same trust model as plugin_deploy.py) rather than introducing a
separate config field - same Rust server box either way, just a
different folder. Loads config.json fresh on every call instead of
caching host/username, so a Plugin Deploy settings change takes effect
immediately without needing its own "reset" call.
"""
import json
import os

import paramiko

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
REMOTE_DIR = "AMAP/Files/Config"


def _sftp_target():
    """Returns (host, username) if Plugin Deploy is actually configured,
    None otherwise - this feature is opt-in by virtue of that, same as the
    API keys (blank/CHANGE_ME just means the feature quietly does nothing)."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return None
    host = cfg.get("plugin_deploy_host", "")
    username = cfg.get("plugin_deploy_username", "")
    if not host or host == "CHANGE_ME" or not username or username == "CHANGE_ME":
        return None
    return host, username


def _connect(host, username):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, username=username, look_for_keys=True, allow_agent=True, timeout=10)
    return client


def pull_json(filename):
    """Returns (data, ok). ok is False if Plugin Deploy isn't configured or
    the server's unreachable - callers should fall back to their own local
    cache and skip pushing back in that case, rather than risk overwriting
    real remote data with an empty/partial result. A file that's never been
    synced before is NOT a failure - that's just an empty {} with ok=True."""
    target = _sftp_target()
    if not target:
        return {}, False
    host, username = target
    try:
        client = _connect(host, username)
        try:
            sftp = client.open_sftp()
            try:
                remote_path = f"/home/{username}/{REMOTE_DIR}/{filename}"
                try:
                    with sftp.open(remote_path, "r") as f:
                        return json.load(f), True
                except FileNotFoundError:
                    return {}, True
            finally:
                sftp.close()
        finally:
            client.close()
    except Exception:
        return {}, False


def push_json(filename, data):
    """Writes `data` to AMAP/Files/Config/<filename> on the Rust server,
    creating that folder if it doesn't exist yet (it normally already does,
    from AMAP's own setup). Best-effort - exceptions are caught and
    swallowed by design, since failing to share data with other admins
    shouldn't ever block the admin who's actually using the dashboard
    right now from saving their own note/stats locally."""
    target = _sftp_target()
    if not target:
        return False
    host, username = target
    try:
        client = _connect(host, username)
        try:
            sftp = client.open_sftp()
            try:
                remote_dir = f"/home/{username}/{REMOTE_DIR}"
                try:
                    sftp.stat(remote_dir)
                except FileNotFoundError:
                    sftp.mkdir(remote_dir)
                remote_path = f"{remote_dir}/{filename}"
                with sftp.open(remote_path, "w") as f:
                    f.write(json.dumps(data, indent=2))
            finally:
                sftp.close()
        finally:
            client.close()
        return True
    except Exception:
        return False

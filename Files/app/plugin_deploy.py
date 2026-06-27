"""
Deploys an uploaded Oxide plugin (.cs file) to the Rust server over SFTP,
and scans it for permission.RegisterPermission(...) calls so newly-declared
permissions show up in the Permissions tab's suggestions without manual
editing. Assumes SSH keys are already set up for the configured user (see
README.md) - there's deliberately no password field, paramiko's
look_for_keys/allow_agent handle the rest, the same trust model as the
Terminal tab's SSH sessions (see ssh_terminal.py).
"""
import re

import paramiko

from permissions_catalog import add_permissions

REGISTER_PERMISSION_RE = re.compile(r'RegisterPermission\(\s*"([^"]+)"')


def upload_plugin(host, username, remote_path, filename, content_bytes):
    """Uploads content_bytes as <remote_path>/<filename> over SFTP, then
    scans it for permissions it declares with a literal string (not a named
    constant - those still need adding by hand, same gap the original
    hand-built catalog had). Returns (ok, message, added_permissions)."""
    if not filename.lower().endswith(".cs"):
        return False, "Only .cs plugin files are supported", []

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    remote_file = remote_path.rstrip("/") + "/" + filename
    try:
        client.connect(hostname=host, username=username, look_for_keys=True, allow_agent=True, timeout=10)
        sftp = client.open_sftp()
        try:
            with sftp.open(remote_file, "wb") as f:
                f.write(content_bytes)
        finally:
            sftp.close()
    except Exception as exc:
        return False, str(exc), []
    finally:
        client.close()

    found = set(REGISTER_PERMISSION_RE.findall(content_bytes.decode("utf-8", errors="replace")))
    added = add_permissions(found) if found else []
    return True, f"Uploaded {filename} to {remote_file}", added


def list_known_plugin_names(oxide_plugins_text):
    """Parses RCON's `oxide.plugins` text output into a clean list of plugin
    names, for the AMAP tab's informational dropdown. A loaded plugin's line
    looks like '  01 "Name" (1.0.0) by Author (0.00s / 0 B) - File.cs'; one
    that failed to compile looks like '  28 PluginName - Failed to compile: ...'."""
    names = []
    for line in oxide_plugins_text.splitlines():
        match = re.match(r'^\s*\d+\s+"([^"]+)"', line) or re.match(r"^\s*\d+\s+(\S+)\s+-\s+Failed to compile", line)
        if match:
            names.append(match.group(1))
    return names

"""
Server status + settings helpers, built on Rust's built-in `serverinfo`
RCON command and the standard server.* convars.
"""
import json

SETTING_CONVARS = {
    "hostname": "server.hostname",
    "url": "server.url",
    "description": "server.description",
    "headerimage": "server.headerimage",
}


def get_server_info(client):
    """Returns the parsed serverinfo JSON (Framerate, Hostname, Players, etc.),
    or {"raw": <text>} if the response wasn't valid JSON. quiet=True - this
    is a background data fetch for the UI, not something to show in the
    live console feed."""
    raw = client.send_command("serverinfo", quiet=True)
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (ValueError, TypeError):
        pass
    return {"raw": raw}


def get_convar(client, name):
    """Read a convar's current value. Sending a convar with no argument
    echoes it back as `server.description: "value` (confirmed against a
    real server) - this strips the echoed name and surrounding quotes."""
    raw = client.send_command(name, quiet=True).strip()
    if ":" in raw:
        raw = raw.split(":", 1)[1].strip()
    if raw.startswith('"'):
        raw = raw[1:]
    if raw.endswith('"'):
        raw = raw[:-1]
    return raw.strip()


def set_convar(client, name, value):
    return client.send_command(f'{name} "{value}"')


def get_server_settings(client):
    """Current values for the editable server.* convars shown in the
    Server Info tab. Hostname is read from serverinfo (reliable); the rest
    fall back to a best-effort convar read."""
    info = get_server_info(client)
    return {
        "hostname": info.get("Hostname") or get_convar(client, SETTING_CONVARS["hostname"]),
        "url": get_convar(client, SETTING_CONVARS["url"]),
        "description": get_convar(client, SETTING_CONVARS["description"]),
        "headerimage": get_convar(client, SETTING_CONVARS["headerimage"]),
    }

"""
AMAP Scripts tab - runs a fixed whitelist of AMAP server-management scripts
via RCON, through the AmapBridge Oxide plugin (see plugins/AmapBridge.cs).

This dictionary is the dashboard-side half of the whitelist - it only
decides which buttons exist and how risky each one is. The plugin enforces
its own independent whitelist of the same action keys, so a request never
reaches the shell unless both sides agree it's a known action.
"""

AMAP_ACTIONS = {
    "backup": {"label": "Server Backup", "danger": False, "confirm": "Run a server backup now?"},
    "update_plugins": {"label": "Update Plugins", "danger": False, "confirm": "Update Oxide and all plugins now?"},
    "update_server": {"label": "Update Server", "danger": True, "confirm": "Apply the latest Rust server update? This may stop the server."},
    "stop": {"label": "Stop Server", "danger": True, "confirm": "Stop the live Rust server now?"},
    "nightly_restart": {"label": "Nightly Restart", "danger": True, "confirm": "Run the nightly restart now? This stops the server - your watchdog/cron brings it back up."},
    "map_wipe": {"label": "Map Wipe", "danger": True, "confirm": "Run a MAP wipe now? This deletes the current map. Player data is kept."},
    "full_wipe": {"label": "Full Wipe", "danger": True, "confirm": "Run a FULL wipe now? This deletes the map AND all player data. This cannot be undone."},
}


def run_amap_action(client, action):
    if action not in AMAP_ACTIONS:
        raise ValueError(f"Unknown action: {action}")
    return client.send_command(f"amap.run {action}")

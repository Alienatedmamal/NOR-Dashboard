"""
AMAP Scripts tab - runs a fixed whitelist of AMAP server-management scripts
via RCON, through the AmapBridge Oxide plugin (see AMAP/Plugins/AmapBridge.cs).

This dictionary is the dashboard-side half of the whitelist - it only
decides which cards exist, how they're labeled, and what confirmation to
show. The plugin enforces its own independent whitelist of the same action
keys (and validates wipe_configure's fields itself too), so a request
never reaches the shell unless both sides agree it's a known action.
"""

AMAP_ACTIONS = {
    "backup": {
        "label": "Server Backup",
        "category": "noncritical",
        "description": "Backs up all server data.",
        "confirm": "Run a server backup now?",
    },
    "log_cleaner": {
        "label": "Log Cleaner",
        "category": "noncritical",
        "description": "Clears the logs.",
        "confirm": "Clear the AMAP logs now?",
    },
    "server_checker": {
        "label": "Server Checker",
        "category": "noncritical",
        "description": "Checks to see if the server is running. If it fails to restart, posts an alert to Discord.",
        "confirm": "Run the server check now?",
    },
    "wipe_configure": {
        "label": "Wipe Configurator",
        "category": "noncritical",
        "description": "Creates the config for the next wipe.",
        "confirm": "Write the next wipe's config with these values?",
        "fields": [
            {"key": "seed", "label": "Seed", "placeholder": "e.g. 897952631"},
            {"key": "map_size", "label": "Map Size", "placeholder": "e.g. 4250"},
            {"key": "wipe_date", "label": "Wipe Date", "placeholder": "MM-DD-YY"},
            {"key": "wipe_type", "label": "Wipe Type", "placeholder": "BP or Map"},
        ],
    },
    "updater": {
        "label": "Updater",
        "category": "critical",
        "description": "Updates the server.",
        "confirm": "Update the server now? This may stop the server.",
    },
    "nightly_restart": {
        "label": "Nightly Restart",
        "category": "critical",
        "description": "Just stops the server (deprecated, but still works).",
        "confirm": "Run the nightly restart now? This stops the server.",
    },
    "map_wipe": {
        "label": "Map Wipe",
        "category": "critical",
        "description": "Wipes the map. Blueprints are kept.",
        "confirm": "Run a MAP wipe now? This deletes the current map. Blueprints are kept.",
    },
    "full_wipe": {
        "label": "Full Wipe",
        "category": "critical",
        "description": "Full wipe - deletes the map and all player data. Cannot be undone.",
        "confirm": "Run a FULL wipe now? This deletes the map AND all player data. This cannot be undone.",
    },
}


def run_amap_action(client, action, fields=None):
    if action not in AMAP_ACTIONS:
        raise ValueError(f"Unknown action: {action}")
    info = AMAP_ACTIONS[action]
    command = f"amap.run {action}"
    if info.get("fields"):
        fields = fields or {}
        for field in info["fields"]:
            command += f' {fields.get(field["key"], "")}'
    return client.send_command(command)

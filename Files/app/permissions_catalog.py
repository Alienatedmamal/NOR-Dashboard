"""
Known permission strings, for the dropdown suggestions on the Permissions
tab. There's no RCON command that lists every registered permission, so
this started as a hand-built list (reading installed plugins' source for
permission.RegisterPermission(...) calls) and now also grows automatically -
see app.py's plugin-upload handler, which regex-scans a newly uploaded
plugin for the same pattern and calls add_permissions() with whatever it
finds.

Backed by permissions_catalog.json (next to this file) instead of a literal
Python list, so it can be safely rewritten at runtime - KNOWN_PERMISSIONS
is exposed the same way either way, for existing callers.
"""
import json
import os
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(BASE_DIR, "permissions_catalog.json")
_lock = threading.Lock()


def _load():
    # install.bat seeds this from permissions_catalog.example.json the same
    # way it does app/config.json, but fall back to empty rather than crash
    # at import time if that somehow didn't happen (e.g. a manual git clone
    # instead of going through install.bat).
    if not os.path.exists(CATALOG_PATH):
        return []
    try:
        with open(CATALOG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return []


def _save(permissions):
    tmp_path = CATALOG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(permissions, f, indent=2)
    os.replace(tmp_path, CATALOG_PATH)


KNOWN_PERMISSIONS = _load()


def add_permissions(new_permissions):
    """Merges newly-discovered permission strings into the catalog and
    persists them. Returns just the ones that were actually new."""
    global KNOWN_PERMISSIONS
    with _lock:
        current = set(KNOWN_PERMISSIONS)
        added = sorted({p for p in new_permissions if p not in current})
        if added:
            KNOWN_PERMISSIONS = sorted(current | set(added))
            _save(KNOWN_PERMISSIONS)
        return added

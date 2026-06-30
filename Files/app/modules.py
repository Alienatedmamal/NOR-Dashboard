"""
Optional feature modules (v1.6+) - AMAP and Terminal are the first two,
pulled out of core so the dashboard's required footprint is just Overview/
Console/Players/Player Lookup/Live Map/Permissions/Server Info. A module is
a folder under MODULES_DIR with a module.json manifest plus its own Python
package, templates/, and static/ - dropped in by hand, picked up on the
next launch (this scans once at startup, not a live filesystem watch).

Module folders are NOT part of this git repo (see .gitignore) - that's a
deliberate, separate distribution story for later. This file only knows
how to load whatever happens to be sitting in MODULES_DIR at launch.

Module contract (module.json):
  {
    "key": "amap",                 // must match the folder name
    "label": "AMAP",
    "description": "...",          // shown in Module Settings
    "min_core_version": "1.6.0",   // gates loading, see _parse_version
    "tab_button": "tab_button.html",   // optional, Jinja-rendered fragment
    "tab_panel": "tab_panel.html",     // optional, Jinja-rendered fragment
    "settings_panel": "settings_panel.html",  // optional
    "js": "amap.js",               // optional, served at /modules/<key>/static/<js>
    "css": null                    // optional, same serving convention
  }

The package's __init__.py exposes:
  register(app, core) -> called once at startup; define @app.route(...)
      handlers here using whatever pieces of `core` (a small namespace of
      shared dashboard primitives) the module needs.
  preflight(core) -> optional; returns {"ok": bool, "message": str}.
      Run from the loading screen before the page reveals, e.g. AMAP's
      "is AmapBridge actually deployed on the remote server" check.
"""
import importlib
import json
import os
import sys

from updater import _parse_version

MODULES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "modules")


class LoadedModule:
    def __init__(self, key, manifest, path, package):
        self.key = key
        self.manifest = manifest
        self.path = path
        self.package = package

    @property
    def label(self):
        return self.manifest.get("label", self.key)

    @property
    def description(self):
        return self.manifest.get("description", "")

    def has_preflight(self):
        return hasattr(self.package, "preflight")

    def run_preflight(self, core):
        if not self.has_preflight():
            return {"ok": True, "message": ""}
        try:
            return self.package.preflight(core)
        except Exception as exc:  # a buggy module's preflight shouldn't break the loading screen
            return {"ok": False, "message": f"Preflight check raised an error: {exc}"}

    def asset_url(self, filename):
        return f"/modules/{self.key}/static/{filename}"

    def script_urls(self):
        """manifest["js"] can be one filename or a list - e.g. Terminal
        needs its vendored xterm.js/xterm-addon-fit.js loaded before its
        own terminal.js, all served from this module's own static/ folder."""
        return self._asset_urls("js")

    def style_urls(self):
        """Same idea as script_urls() but for manifest["css"] - e.g.
        Terminal's vendored xterm.css."""
        return self._asset_urls("css")

    def _asset_urls(self, manifest_key):
        value = self.manifest.get(manifest_key)
        if not value:
            return []
        names = [value] if isinstance(value, str) else value
        return [self.asset_url(name) for name in names]

    def render_fragment(self, fragment_key, **context):
        """Reads modules/<key>/templates/<fragment file> and renders it
        through Flask's own Jinja environment (so url_for/etc. work inside
        it), or returns "" if this module didn't declare that fragment."""
        filename = self.manifest.get(fragment_key)
        if not filename:
            return ""
        template_path = os.path.join(self.path, "templates", filename)
        if not os.path.isfile(template_path):
            return ""
        from flask import render_template_string
        with open(template_path, "r", encoding="utf-8") as f:
            source = f.read()
        return render_template_string(source, module=self, **context)


def _read_manifest(module_dir):
    manifest_path = os.path.join(module_dir, "module.json")
    if not os.path.isfile(manifest_path):
        return None
    with open(manifest_path, "r", encoding="utf-8") as f:
        return json.load(f)


def discover(core_version):
    """Scans MODULES_DIR for valid, version-compatible module folders.
    Returns (loaded, skipped) - skipped is a list of (key, reason) for
    anything found but not activated, so app.py can log it instead of
    silently doing nothing."""
    loaded = []
    skipped = []
    if not os.path.isdir(MODULES_DIR):
        return loaded, skipped

    if MODULES_DIR not in sys.path:
        sys.path.insert(0, MODULES_DIR)

    for key in sorted(os.listdir(MODULES_DIR)):
        module_dir = os.path.join(MODULES_DIR, key)
        if not os.path.isdir(module_dir) or key.startswith((".", "_")):
            continue
        manifest = _read_manifest(module_dir)
        if manifest is None:
            skipped.append((key, "no module.json found"))
            continue
        if manifest.get("key") != key:
            skipped.append((key, f"module.json key '{manifest.get('key')}' doesn't match folder name"))
            continue

        min_version = manifest.get("min_core_version", "0")
        if _parse_version(core_version) < _parse_version(min_version):
            skipped.append((key, f"requires dashboard v{min_version}+, this install is v{core_version} - update the dashboard first"))
            continue

        try:
            package = importlib.import_module(key)
        except Exception as exc:
            skipped.append((key, f"failed to import: {exc}"))
            continue
        if not hasattr(package, "register"):
            skipped.append((key, "module has no register(app, core) function"))
            continue

        loaded.append(LoadedModule(key, manifest, module_dir, package))

    # Optional "order" field in module.json controls tab position.
    # Modules without it default to 0 and sort alphabetically among
    # themselves; higher numbers go later (DevTools uses 100 to land
    # after all standard modules but still before Help).
    loaded.sort(key=lambda m: (m.manifest.get("order", 0), m.key))

    return loaded, skipped


def register_static_route(app):
    """One generic static-file route for every loaded module, rather than
    each module needing its own Blueprint just to serve its JS/CSS."""
    from flask import abort, send_from_directory

    @app.route("/modules/<module_key>/static/<path:filename>")
    def module_static(module_key, filename):
        safe_key = os.path.basename(module_key)
        folder = os.path.join(MODULES_DIR, safe_key, "static")
        if not os.path.isdir(folder):
            abort(404)
        return send_from_directory(folder, filename)

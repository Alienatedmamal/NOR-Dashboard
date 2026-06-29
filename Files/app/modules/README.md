Drop optional dashboard modules in here, one folder per module, then relaunch
the dashboard - each module is picked up automatically on startup (see
`app/modules.py` for the loader, and `app/app.py`'s module-loading block for
how it's wired in). Modules are a separate distribution from this repo, not
tracked here (see `.gitignore`) - this folder is empty except for this file
until you add some.

A module folder needs a `module.json` manifest plus a Python package
(`__init__.py` exposing `register(app, core)` and optionally
`preflight(core)`) - see this dashboard's release notes or the module's own
README for what's available (currently: AMAP, Terminal).

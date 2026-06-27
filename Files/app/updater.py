"""
In-app version check + update, mirroring update.ps1's logic so this can be
done from Settings > Update without leaving the browser - update.bat still
works exactly as before for anyone who'd rather double-click a file.
"""
import os
import re
import shutil
import subprocess
import tempfile
import zipfile

import requests

REPO_ZIP_URL = "https://github.com/Alienatedmamal/NOR-RCON-Dashboard/archive/refs/heads/main.zip"
REPO_VERSION_URL = "https://raw.githubusercontent.com/Alienatedmamal/NOR-RCON-Dashboard/main/VERSION"


def _parse_version(text):
    """'1.2.8' -> (1, 2, 8). Ignores anything that doesn't look like a
    dotted-integer version rather than raising, so a weird/empty response
    can't crash the check - it just won't compare as newer."""
    parts = re.findall(r"\d+", text or "")
    return tuple(int(p) for p in parts) if parts else (0,)


def check_for_update(current_version):
    resp = requests.get(REPO_VERSION_URL, timeout=10)
    resp.raise_for_status()
    latest_version = resp.text.strip()
    return {
        "current_version": current_version,
        "latest_version": latest_version,
        "update_available": _parse_version(latest_version) > _parse_version(current_version),
    }


def apply_update(project_dir):
    """Downloads the latest ZIP and applies it on top of project_dir - same
    approach as update.ps1 (robocopy, not shutil.copytree, so an existing
    same-named folder gets merged into rather than nested inside it).
    Raises RuntimeError on failure. config.json and local data files are
    never part of the ZIP (gitignored), so they're never touched - same
    guarantee update.ps1 already makes."""
    with tempfile.TemporaryDirectory(prefix="nor_dashboard_update_") as temp_dir:
        zip_path = os.path.join(temp_dir, "update.zip")
        resp = requests.get(REPO_ZIP_URL, timeout=60)
        resp.raise_for_status()
        with open(zip_path, "wb") as f:
            f.write(resp.content)

        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(temp_dir)

        # GitHub's archive ZIPs put everything inside one top-level folder
        # named "<repo>-<branch>" - find it by elimination, same as update.ps1.
        extracted_root = next(
            (os.path.join(temp_dir, name) for name in os.listdir(temp_dir)
             if os.path.isdir(os.path.join(temp_dir, name))),
            None,
        )
        if not extracted_root:
            raise RuntimeError("Downloaded ZIP didn't contain what was expected")

        _robocopy(extracted_root, project_dir)

        # The ZIP packages everything except install.bat/README.md/VERSION
        # inside a "Files" folder (see install.bat) - unpack it into place
        # the same way, so this actually replaces the running code instead
        # of leaving it nested uselessly inside Files\.
        files_dir = os.path.join(project_dir, "Files")
        if os.path.isdir(files_dir):
            _robocopy(files_dir, project_dir, move=True)
            shutil.rmtree(files_dir, ignore_errors=True)


def _robocopy(source, destination, move=False):
    args = ["robocopy", source, destination, "/E"]
    if move:
        args.append("/MOVE")
    result = subprocess.run(args, capture_output=True, text=True)
    # robocopy's exit codes are bit flags - 0-7 are all success (files
    # copied/extra files present), 8+ means a real failure.
    if result.returncode >= 8:
        raise RuntimeError(f"robocopy failed (exit code {result.returncode}): {result.stdout[-500:]}")

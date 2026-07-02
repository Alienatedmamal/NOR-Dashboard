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

REPO_ZIP_URL = "https://github.com/Alienatedmamal/NOR-Dashboard/archive/refs/heads/main.zip"
REPO_VERSION_URL = "https://raw.githubusercontent.com/Alienatedmamal/NOR-Dashboard/main/VERSION"
REPO_RELEASES_URL = "https://api.github.com/repos/Alienatedmamal/NOR-Dashboard/releases"


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


def get_releases():
    """Returns a list of {tag, name, published_at, zipball_url} dicts, newest first."""
    resp = requests.get(REPO_RELEASES_URL, timeout=10, headers={"Accept": "application/vnd.github+json"})
    resp.raise_for_status()
    releases = resp.json()
    return [
        {
            "tag": r.get("tag_name", ""),
            "name": r.get("name") or r.get("tag_name", ""),
            "published_at": r.get("published_at", ""),
            "zipball_url": r.get("zipball_url", ""),
        }
        for r in releases
        if r.get("zipball_url")
    ]


def apply_release(project_dir, zipball_url):
    """Downloads the ZIP for a specific release (by its GitHub zipball_url) and
    applies it the same way apply_update() does for the latest main branch."""
    with tempfile.TemporaryDirectory(prefix="nor_dashboard_rollback_") as temp_dir:
        zip_path = os.path.join(temp_dir, "release.zip")
        resp = requests.get(zipball_url, timeout=60, allow_redirects=True)
        resp.raise_for_status()
        with open(zip_path, "wb") as f:
            f.write(resp.content)

        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(temp_dir)

        extracted_root = next(
            (os.path.join(temp_dir, name) for name in os.listdir(temp_dir)
             if os.path.isdir(os.path.join(temp_dir, name))),
            None,
        )
        if not extracted_root:
            raise RuntimeError("Release ZIP didn't contain what was expected")

        _robocopy(extracted_root, project_dir)

        files_dir = os.path.join(project_dir, "Files")
        if os.path.isdir(files_dir):
            _robocopy(files_dir, project_dir, move=True)
            shutil.rmtree(files_dir, ignore_errors=True)


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

        # robocopy can silently skip a file it can't open (e.g. OneDrive
        # briefly locking it) and still return exit code 1 (success).
        # Write VERSION explicitly via Python as a belt-and-suspenders
        # guarantee - it's what the running process reads at startup to
        # decide whether a restart brought in a new version.
        src_ver = os.path.join(extracted_root, "VERSION")
        dst_ver = os.path.join(project_dir, "VERSION")
        if os.path.exists(src_ver):
            with open(src_ver, "r", encoding="utf-8") as f:
                ver_text = f.read().strip()
            with open(dst_ver, "w", encoding="utf-8") as f:
                f.write(ver_text)


def _robocopy(source, destination, move=False):
    args = ["robocopy", source, destination, "/E"]
    if move:
        args.append("/MOVE")
    result = subprocess.run(args, capture_output=True, text=True)
    # robocopy's exit codes are bit flags - 0-7 are all success (files
    # copied/extra files present), 8+ means a real failure.
    if result.returncode >= 8:
        raise RuntimeError(f"robocopy failed (exit code {result.returncode}): {result.stdout[-500:]}")

# Downloads the latest version of NOR Dashboard from GitHub as a plain ZIP
# and overwrites the files in this folder with it. No git required - this
# is meant to be as easy as install.bat/run.bat for an admin with no
# command-line experience. config.json and the local data files are never
# touched because they're gitignored, so they're simply absent from the
# downloaded ZIP - nothing to overwrite.

$repoZipUrl = "https://github.com/Alienatedmamal/NOR-RCON-Dashboard/archive/refs/heads/main.zip"
$projectDir = $PSScriptRoot
$tempDir = Join-Path $env:TEMP "nor_dashboard_update_$(Get-Random)"
$zipPath = Join-Path $tempDir "update.zip"

Write-Output "Downloading the latest version..."
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
try {
    Invoke-WebRequest -Uri $repoZipUrl -OutFile $zipPath -UseBasicParsing
} catch {
    Write-Output "Could not download the update: $_"
    Write-Output "Check your internet connection, or that the GitHub repo is set to public."
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Output "Extracting..."
Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force

# GitHub's archive ZIPs put everything inside one top-level folder named
# "<repo>-<branch>" - find it by elimination rather than hardcoding the name.
$extractedRoot = Get-ChildItem -Path $tempDir -Directory | Where-Object { $_.FullName -ne $tempDir } | Select-Object -First 1
if (-not $extractedRoot) {
    Write-Output "Update failed - the downloaded ZIP didn't contain what was expected."
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Output "Applying update..."
# robocopy, not Copy-Item -Recurse - when the destination already has a
# same-named subfolder (e.g. a leftover Files\ from a previous run),
# Copy-Item -Recurse can nest it (Files\Files\...) instead of merging into
# it. robocopy always reconciles file-by-file against the existing tree.
& robocopy $extractedRoot.FullName $projectDir /E | Out-Null
if ($LASTEXITCODE -ge 8) {
    Write-Output "Update failed - couldn't copy the new files into place."
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# The ZIP packages everything except install.bat/README.md/VERSION inside a
# "Files" folder (see install.bat) - on an existing install, the line above
# just dropped a fresh copy of it alongside the files already in place from
# last time, not on top of them. Unpack it the same way install.bat does on
# a fresh install, so this actually replaces the running code instead of
# leaving the update nested uselessly inside Files\.
$filesDir = Join-Path $projectDir "Files"
if (Test-Path $filesDir) {
    & robocopy $filesDir $projectDir /E /MOVE | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Write-Output "Warning: couldn't fully unpack the Files folder - check $filesDir manually."
    } elseif (Test-Path $filesDir) {
        # robocopy /MOVE usually removes the now-empty source folder itself
        # too, but isn't always guaranteed to (e.g. a sync client like
        # OneDrive briefly locking something inside it) - clean up anything
        # left behind so it doesn't linger as confusing clutter.
        Remove-Item -Path $filesDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ""
Write-Output "Update complete. Restart run.bat to pick up any code changes."

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
Copy-Item -Path (Join-Path $extractedRoot.FullName "*") -Destination $projectDir -Recurse -Force

Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ""
Write-Output "Update complete. Restart run.bat to pick up any code changes."

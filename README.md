# NOR Dashboard v1.6.4

A simple admin dashboard for your Rust server: an at-a-glance overview (player count, queue, BattleMetrics rank, and more), a live console feed, server info/settings, online/offline/banned player management with notes, permission management, player ban/Steam history lookups, a live map with player and world-event tracking, and a wipe countdown. Same black-and-neon-green look as nor.workisboring.com. Optional modules add extra tabs - see "Modules" below.

This doc covers one-time setup. Once it's running, see `ADMIN-GUIDE.md` for how to actually use each tab day-to-day.

## Prerequisites

Core only needs RCON access to your Rust server - nothing extra to install for Overview, Console, Players, Player Lookup, Permissions, Server Info, or Live Map. Optional modules may have their own prerequisites (documented with each module separately).

## Modules (v1.6+)

Core covers Overview, Console, Players, Player Lookup, Live Map, Permissions, and Server Info - everything else is an optional module, distributed separately from this repo. Drop a module's folder into `app/modules/` and relaunch the dashboard to pick it up; its tab, settings, and any dependencies it needs were already shipped with this release (run.bat's `pip install` covers whatever any known module needs, every launch, regardless of whether you've actually installed that module). A module that needs a newer core than what you're running gets skipped with a clear reason in Settings > Module Settings, rather than failing silently.

## One-time setup

1. **Double-click `install.bat`.** (Everything else in the download is tucked inside the `Files` folder - that's expected, `install.bat` unpacks it into place on first run.) It checks for Python and installs it automatically (via `winget`) if it's missing, then installs the small set of packages this needs (`app/requirements.txt`: Flask, flask-sock, websocket-client, requests, paramiko), and creates `app/config.json` from the template if it doesn't already exist.
   - If Windows shows a blue "Windows protected your PC" warning when you double-click it, that's just because the file came from the internet, not because anything's wrong - click **More info**, then **Run anyway**.
   - If it can't install Python automatically (no `winget`), it'll print a link to download Python yourself - check **"Add python.exe to PATH"** during that install, then run `install.bat` again.
2. **Edit `app/config.json`**: right-click it → **Open with** → **Notepad**, fill in the values below, then save (Ctrl+S) and close. These three are required - the dashboard won't start without them:
   - `rcon_host` - your Rust server's IP address
   - `rcon_port` - your RCON port (LGSM's `rcon.port`, default `28016`)
   - `rcon_password` - your RCON password (LGSM's `rcon.password`)

   These are optional - leave them as `"CHANGE_ME"` for now and the dashboard still runs fine, just with the related feature turned off until you fill them in (or skip editing the file at all and fill them in later from **Settings > API Keys** inside the dashboard itself - same effect, no restart needed either way):
   - `steam_api_key` - a free key from https://steamcommunity.com/dev/apikey (Player Lookup tab, Rust hours, and player avatars). When it asks for a domain name, you can put anything, e.g. `localhost`.
   - `rustmaps_api_key` - a free key from https://rustmaps.com/dashboard (Live Map tab's background image - the rest of the Live Map tab works without it)
   - `battlemetrics_id` - your server's ID from its BattleMetrics page (the number in the URL, e.g. `battlemetrics.com/servers/rust/39370730` → `39370730`). No account or API key needed - just the ID. Powers the Overview tab's Rank stat.
3. Make sure this PC can actually reach your Rust server's RCON port (same network, or whatever your firewall/router allows).

## Running it

Double-click **`run.bat`**. (Same Windows warning as before if it shows up - More info → Run anyway.) It runs in the background with no console window - after a couple seconds your browser opens to the dashboard automatically.

**Closing the dashboard's browser window is what shuts it down now** - there's no console window to manage. Refreshing the page, switching tabs, or just leaving the window in the background while you do something else doesn't close it; only actually closing that browser window does (it can take up to about a minute and a half to notice and shut down after you close it - deliberately generous, since browsers slow down a backgrounded tab's timers and a shorter timeout would risk shutting down while you're just alt-tabbed away, not actually closed). Next time, just double-click `run.bat` again (no need to re-run `install.bat`).

If something goes wrong, errors show up as a pop-up notification in the bottom-right corner of the dashboard itself, with a suggested fix. If the dashboard fails to start at all, you'll get a one-time pop-up telling you to check `dashboard.log` - see "Log files" below for what that and the other two are.

`install.bat` also puts a **"Launch NOR Dashboard"** shortcut on your Desktop automatically (with its own icon), plus a copy in this folder - pin either one to the taskbar if you want.

## Checking for updates

Easiest way: **Settings > Update** inside the dashboard itself - click **Check for Updates**, and if one's available, click **Update Now**. Same effect as `update.bat` below, just without leaving the browser; you'll get a pop-up reminding you to restart `run.bat` once it's done (the page itself doesn't reload, since the running dashboard's already-loaded code can't update itself out from under itself - only a fresh restart picks up the new code).

Or double-click **`update.bat`**. It downloads the latest version straight from GitHub and overwrites the files in this folder - no git, no command line, nothing to install. Either way, `app/config.json` and your local data (notes, player stats, map cache) are never touched, since they're not part of what gets downloaded. See `ADMIN-GUIDE.md` for the step-by-step version.

## Log files

Three show up in this same folder once you've run the dashboard, each for a different purpose:

- **`dashboard-events.log`** - check this one first. A small, plain-English running history: RCON connects/drops, actions run, settings changes, and anything unexpected, each with a timestamp. Persists across restarts (it rotates instead of growing forever once it gets large), so it's still there to check even if the dashboard's been restarted since whatever you're investigating happened.
- **`dashboard.log`** - the Flask server's raw output: every request it handles, plus a full Python traceback for anything that crashes. More detailed than `dashboard-events.log`, but only holds the *latest* run - it's overwritten fresh every time `run.bat` starts the dashboard, so it's only useful to check right after something goes wrong, not after a restart.
- **`dashboard-startup.log`** - just two boilerplate lines. Rarely useful; only worth a look if the other two are empty too.

## What's in here

- **Overview** - the landing page: hostname/description straight from RCON over your server's own header image (`server.headerimage`, set in the Server Info tab - falls back to a default background if it's not set), stat cards (players, queued, BattleMetrics rank, framerate, game time, uptime, map, entity count), an entity count history graph (sampled every 5 minutes, local to this install - see below), and the live connected-players list.
- **Console** - a live feed of everything your server logs (plugin loads, warnings, chat, command output...), same idea as RustAdmin's console. Type a command and its response shows up in the same feed within a second or two, interleaved with everything else. Below it, **Broadcast Message** sends a chat message to everyone connected. The Online Players sidebar has a one-click **Kick** per player, and above it, **Give Item** gives a chosen item/quantity to a currently-connected player from a curated list of common items.
- **Players** - online players (name, SteamID, IP, ping, session/total time, last connected, Rust hours, VAC/game ban status) with one-click kick, ban/unban (reason required and logged), and Look up; plus recently-seen offline players (with their last-known IP) and currently-banned players, each with a filter box to find someone by name or SteamID without scrolling. Select multiple players with the checkboxes for bulk kick/ban (online) or bulk unban (banned). A per-player notes log (kick and ban reasons are both added automatically), with a search box to find a keyword across every player's notes at once instead of needing a SteamID first - if a player with existing notes reconnects, you'll get a toast (and optionally a sound, see Settings > Notifications) right when it happens.
- **Player Lookup** - paste a SteamID64 to see their Steam profile, account age, VAC/game ban counts, and community/economy ban status.
- **Live Map** - your actual map image (via RustMaps.com) with live-updating icon markers for online players (avatar + name), world events (cargo ship, patrol helicopter, Bradley APC, CH47, cargo plane), and the map's small/large oil rigs (fixed monument locations, shown as soon as the map loads). No plugin required; built entirely on vanilla RCON commands and RustMaps' own monument data (the seed/world size come straight from `server.seed`/`server.worldsize`, so it always matches the live map).
- **Permissions** - grant/revoke an Oxide permission on a player or group, add/remove a player from a group (picked from a dropdown of your server's actual groups, not typed blind), create a new group, and check what permissions/groups a player or group currently has.
- **Server Info** - live stats (players, map, framerate, uptime, entity count, etc.) and editable server settings (hostname, URL, description, header image), pre-filled with the current values.
- **Help** - a Show FAQ / Troubleshooting button for quick answers without leaving the dashboard, and a link out to this project's GitHub repo; more in-app guidance is planned for this tab later.
- **Settings** (gear icon, top right of the tab bar) - core sub-pages: **RCON** (edit host/port/password without touching `config.json` by hand, reconnects immediately); **API Keys** (Steam Web, RustMaps, and BattleMetrics ID - the same three optional fields from one-time setup above, editable here instead of by hand in `config.json`; the Steam Web and RustMaps fields are masked like a password box, since they're real secrets - BattleMetrics ID isn't, it's just a public server ID); **Theme** (a dropdown of five presets, or your own accent/background/text/alert colors - changes preview instantly, but click **Save** to keep it for next time); **Wipe Countdown** (Daily, Bi-weekly, or Monthly, plus time/timezone); **Notifications** (turn the startup guided tour off for good, or bring it back with Replay Tour; toggle the sound that plays alongside the noted-player-reconnected toast); **Update** (check for and install the latest version without leaving the browser - see "Checking for updates" below); plus **Module Settings**, shown whenever at least one module is installed - each loaded module's own settings live here. All of these are saved in *this install's* `config.json` - not synced, so a different admin's own separate copy of the dashboard keeps its own independent settings.
- **Wipe countdown** - in the header, counting down based on whatever's set in Settings > Wipe Countdown (defaults to 2pm Central on the first Thursday of the month), DST-aware, auto-advancing to the next occurrence once it passes.

The window opens maximized and the whole layout scales to fill it - it's no longer capped to a narrow centered column.

## Giving this to other admins

Copy the whole `NOR-Dashboard` folder to their PC (or zip it up).

- **`app/config.json`** holds your RCON password and API keys. If this admin already has (or should have) full RCON access anyway, it's fine to include as-is so they're up and running immediately. If not, delete it before sharing (or just don't include it) - `app/config.example.json` is the safe template that ships instead, and `install.bat` will recreate `app/config.json` from it.
- **`.pyexe`** and the **`app/__pycache__`** folder are machine-specific and safe to delete before sharing - both get regenerated automatically (`.pyexe` by `install.bat`, `app/__pycache__` the first time Python runs).
- **`app/player_notes.json`, `app/player_stats.json`, `app/map_cache.json`** hold this server's accumulated notes/ban reasons, player history, and cached map data. Leave them in if you want the other admin to see the same history immediately; delete them for a clean slate.

Each admin then:

1. Double-clicks `install.bat` (sets up Python/packages and creates a fresh `app/config.json` for them if one isn't already there).
2. Fills in `app/config.json` with the same server details you use, if it wasn't already filled in.
3. Double-clicks `run.bat`.
4. From then on, double-clicks `update.bat` whenever you tell them a new version is out.

## Notes

- This only binds to `127.0.0.1` (your own PC) - it's deliberately not reachable over your network, since `app/config.json` holds your RCON password.
- The dashboard now runs windowless - no console, just the browser window. It shuts itself down automatically within about a minute and a half of you closing that window (not while it's merely in the background - see "Running it" above). See "Log files" above if you ever need to check what it's been doing.
- If the RCON connection drops or the server restarts, the dashboard reconnects automatically next time it needs to talk to it.
- It's normal to see `NOR Dashboard connected` show up periodically (every 15 seconds) in the server's own console/logs - that's just the dashboard's connection health-check, confirming RCON is reachable and everything is working. It's hidden from the dashboard's own Console tab feed on purpose, but still visible to anyone watching the raw server console directly.
- The Players list parses your server's `playerlist` RCON response into a table; the Server Info tab uses the built-in `serverinfo` command; the Live Map's event markers use the built-in `find_entity` command - all tested against your actual server and working.
- Without a `rustmaps_api_key`, the Live Map tab still shows live player/event markers - just without the background map image or the oil rig markers, since both of those come from RustMaps' own data, not RCON. The very first time RustMaps sees a given seed/world size, generating the image (and the oil rig positions, fetched the same trip) can take a couple minutes; the tab shows a "generating" message and a Refresh button until it's ready.
- Without a `battlemetrics_id`, the Overview tab still shows everything else - Rank just stays blank.
- The Overview tab's background image normally comes from `server.headerimage` (see "What's in here" above) - `app/static/img/bg.jpg` is only a fallback, shown if `headerimage` isn't set on your server (or hasn't loaded yet). Swap that file for your own image (same filename) if you want a different fallback.

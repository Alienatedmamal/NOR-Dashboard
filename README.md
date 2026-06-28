# NOR Dashboard v1.2.13

A simple admin dashboard for your Rust server: an at-a-glance overview (player count, queue, BattleMetrics rank, and more), a live console feed, server info/settings, online/offline/banned player management with notes, permission management, player ban/Steam history lookups, a live map with player and world-event tracking, an AMAP tab for running server-management scripts, and a wipe countdown. Same black-and-neon-green look as AMAP and nor.workisboring.com.

This doc covers one-time setup. Once it's running, see `ADMIN-GUIDE.md` for how to actually use each tab day-to-day.

## One-time setup

1. **Double-click `install.bat`.** (Everything else in the download is tucked inside the `Files` folder - that's expected, `install.bat` unpacks it into place on first run.) It checks for Python and installs it automatically (via `winget`) if it's missing, then installs the three small packages this needs (Flask, websocket-client, requests), and creates `app/config.json` from the template if it doesn't already exist.
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

## Setting up AMAP on your Rust server

The AMAP tab needs two things installed directly on the **Rust server itself** (not this PC) - the AMAP scripts, and the AmapBridge plugin that lets RCON commands actually run them. Do this once per Rust server you want the AMAP tab to control.

On the Rust server (SSH in, or open a terminal on the box):

1. Clone this repo:
   ```bash
   git clone https://github.com/Alienatedmamal/NOR-RCON-Dashboard.git
   ```
2. Move the `AMAP` folder into your home directory - replace `USERNAME` with the Linux user your Rust server actually runs as:
   ```bash
   mv NOR-RCON-Dashboard/AMAP /home/USERNAME/
   ```
3. The rest of the cloned repo isn't needed on the Rust server - clean it up:
   ```bash
   rm -rf NOR-RCON-Dashboard/
   ```
4. Deploy the plugin into Oxide's plugins folder - adjust the `serverfiles` path if yours differs:
   ```bash
   cd /home/USERNAME/AMAP/Plugins
   mv AmapBridge.cs /home/USERNAME/serverfiles/oxide/plugins/AmapBridge.cs
   ```
   Oxide compiles and loads it automatically within a few seconds - check the server console for `Loaded plugin AmapBridge` to confirm.
5. Make the scripts executable - this is needed for AMAP and the dashboard to actually be able to run them:
   ```bash
   chmod +x /home/USERNAME/AMAP/Files/Scripts/*
   ```

That's it - the AMAP tab will now work against this server. The plugin figures out file paths from whatever Linux account it's actually running under, so there's nothing to edit inside `AmapBridge.cs` itself, even across different servers with different usernames.

## Setting up SSH keys for the Plugin Upload feature

The AMAP tab's **Upload Plugin** panel sends files to your Rust server over SFTP using a regular SSH key - the same kind you'd use to SSH into the box by hand - rather than a password. If you can already SSH into your Rust server without being asked for a password, you can skip this section; otherwise, from this Windows PC:

1. Open PowerShell and check whether you already have a key:
   ```powershell
   dir $env:USERPROFILE\.ssh\id_ed25519.pub
   ```
   If that shows a file, skip to step 3. If it says the path doesn't exist, continue to step 2.
2. Generate a new key (press Enter at every prompt to accept the defaults, including an empty passphrase - a passphrase would mean typing it in every time the dashboard tries to upload a plugin):
   ```powershell
   ssh-keygen -t ed25519
   ```
3. Copy the public key over to the Rust server - replace `USERNAME` and `SERVER_IP` with the real values (the same ones you'll enter in Settings > Plugin Deploy):
   ```powershell
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh USERNAME@SERVER_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
   ```
   (If your Windows PC has `ssh-copy-id` available, `ssh-copy-id USERNAME@SERVER_IP` does the same thing in one step.)
4. Test it - this should log you in with no password prompt:
   ```powershell
   ssh USERNAME@SERVER_IP
   ```

Once that works, fill in the same host/username and the path to your `oxide/plugins` folder (e.g. `/home/USERNAME/serverfiles/oxide/plugins`) in the dashboard's Settings > Plugin Deploy section.

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

- **`dashboard-events.log`** - check this one first. A small, plain-English running history: RCON connects/drops, AMAP actions run, settings changes, and anything unexpected, each with a timestamp. Persists across restarts (it rotates instead of growing forever once it gets large), so it's still there to check even if the dashboard's been restarted since whatever you're investigating happened.
- **`dashboard.log`** - the Flask server's raw output: every request it handles, plus a full Python traceback for anything that crashes. More detailed than `dashboard-events.log`, but only holds the *latest* run - it's overwritten fresh every time `run.bat` starts the dashboard, so it's only useful to check right after something goes wrong, not after a restart.
- **`dashboard-startup.log`** - just two boilerplate lines. Rarely useful; only worth a look if the other two are empty too.

## What's in here

- **Overview** - the landing page: hostname/description straight from RCON over your server's own header image (`server.headerimage`, set in the Server Info tab - falls back to a default background if it's not set), stat cards (players, queued, BattleMetrics rank, framerate, game time, uptime, map, entity count), and the live connected-players list.
- **Console** - a live feed of everything your server logs (plugin loads, warnings, chat, command output...), same idea as RustAdmin's console. Type a command and its response shows up in the same feed within a second or two, interleaved with everything else.
- **Players** - online players (name, SteamID, IP, ping, session/total time, last connected, Rust hours) with one-click ban/unban (reason required and logged) and Look up; plus recently-seen offline players, currently-banned players, and a per-player notes log (ban reasons are added automatically).
- **Player Lookup** - paste a SteamID64 to see their Steam profile, account age, VAC/game ban counts, and community/economy ban status.
- **Live Map** - your actual map image (via RustMaps.com) with live-updating markers for online players (avatar + name) and world events - cargo ship, patrol helicopter, Bradley APC, CH47, cargo plane. No plugin required; built entirely on vanilla RCON commands (the seed/world size come straight from `server.seed`/`server.worldsize`, so it always matches the live map). Click and drag to pan around it.
- **Permissions** - grant/revoke an Oxide permission on a player or group, add/remove a player from a group (picked from a dropdown of your server's actual groups, not typed blind), create a new group, and check what permissions/groups a player or group currently has.
- **Server Info** - live stats (players, map, framerate, uptime, entity count, etc.) and editable server settings (hostname, URL, description, header image), pre-filled with the current values.
- **AMAP** - runs a fixed set of your AMAP server-management scripts (backup, log cleaner, server checker, wipe configurator, updater, map/full wipe) over RCON - no SSH needed. Each is shown as a card with a description and a Critical/Noncritical tag; Critical actions require typing the action's name to confirm. Also has an **Upload Plugin** panel that sends a `.cs` file straight to your server's `oxide/plugins` folder over SFTP (set the destination once in Settings > Plugin Deploy) and picks up any permissions it declares automatically. See "AMAP tab setup" below for how this actually works, and `ADMIN-GUIDE.md` for what each one does.
- **Terminal** - a real interactive SSH terminal embedded in the page (via `xterm.js`), for when you need an actual shell instead of AMAP's fixed action list. Type a host/port/username/password and connect - nothing typed there is ever saved to disk.
- **Settings** (gear icon, top right of the tab bar) - six sub-pages: **RCON** (edit host/port/password without touching `config.json` by hand, reconnects immediately); **API Keys** (Steam Web, RustMaps, and BattleMetrics ID - the same three optional fields from one-time setup above, editable here instead of by hand in `config.json`); **Theme** (a dropdown of five presets, or your own accent/background/text/alert colors - changes preview instantly, but click **Save** to keep it for next time, shared by anyone using this dashboard, same as Wipe Schedule below); **Wipe Schedule** (Daily, Bi-weekly, or Monthly, plus time/timezone - saved for the server, shared by anyone using this dashboard); **Plugin Deploy** (the SSH target the AMAP tab's plugin upload uses); **Update** (check for and install the latest version without leaving the browser - see "Checking for updates" below).
- **Wipe countdown** - in the header, counting down based on whatever's set in Settings > Wipe Schedule (defaults to 2pm Central on the first Thursday of the month), DST-aware, auto-advancing to the next occurrence once it passes.

The window opens maximized and the whole layout scales to fill it - it's no longer capped to a narrow centered column.

## AMAP tab setup

This tab needs a small custom Oxide plugin, `AMAP/Plugins/AmapBridge.cs`, installed on the server - it's what lets an RCON command actually run a shell script on the box. See "Setting up AMAP on your Rust server" above for the first-time install; `AMAP/Plugins/AmapBridge.cs` in this repo is the source of truth if you ever need to redeploy it later (e.g. after a fresh Oxide install) - just copy it back into `oxide/plugins/` and the server will compile and load it automatically within a few seconds.

The plugin only recognizes a fixed, hardcoded list of action keywords (see the `Actions` dictionary at the top of the file) - it never accepts or runs arbitrary shell text from RCON. Adding a new dashboard button means adding a new line to both that dictionary and `app/amap_commands.py`'s `AMAP_ACTIONS`, not changing what kind of input is accepted.

There's no password on this tab - Critical actions (Updater, Map Wipe, Full Wipe) require typing the action's exact name into the confirmation popup before they'll run, which is the actual protection against a stray click. Anyone with the dashboard open can see the tab and its options, same as everything else in the dashboard.

The rest of `AMAP/` in this repo is a sanitized backup copy of the actual AMAP scripts running on the server, in case the live ones on the server ever need to be restored - real secrets (Discord webhooks, the RCON password) are replaced with `CHANGE_ME` placeholders.

## Giving this to other admins

Copy the whole `NOR-Dashboard` folder to their PC (or zip it up).

- **`app/config.json`** holds your RCON password and API keys. If this admin already has (or should have) full RCON access anyway, it's fine to include as-is so they're up and running immediately. If not, delete it before sharing (or just don't include it) - `app/config.example.json` is the safe template that ships instead, and `install.bat` will recreate `app/config.json` from it.
- **`.pyexe`** and the **`app/__pycache__`** folder are machine-specific and safe to delete before sharing - both get regenerated automatically (`.pyexe` by `install.bat`, `app/__pycache__` the first time Python runs).
- **`app/player_notes.json`, `app/player_stats.json`, `app/map_cache.json`** hold this server's accumulated notes/ban reasons, player history, and cached map data. Leave them in if you want the other admin to see the same history; delete them for a clean slate.

Each admin then:

1. Double-clicks `install.bat` (sets up Python/packages and creates a fresh `app/config.json` for them if one isn't already there).
2. Fills in `app/config.json` with the same server details you use, if it wasn't already filled in.
3. Double-clicks `run.bat`.
4. From then on, double-clicks `update.bat` whenever you tell them a new version is out.

## Notes

- This only binds to `127.0.0.1` (your own PC) - it's deliberately not reachable over your network, since `app/config.json` holds your RCON password.
- The dashboard now runs windowless - no console, just the browser window. It shuts itself down automatically within about a minute and a half of you closing that window (not while it's merely in the background - see "Running it" above). See "Log files" above if you ever need to check what it's been doing.
- If the RCON connection drops or the server restarts, the dashboard reconnects automatically next time it needs to talk to it.
- It's normal to see `NOR Dashboard connected` show up periodically (every 15 seconds) in the server's own console/logs - that's just the dashboard's connection health-check, confirming RCON is reachable and everything (including the AMAP tab) is working. It's hidden from the dashboard's own Console tab feed on purpose, but still visible to anyone watching the raw server console directly.
- The Players list parses your server's `playerlist` RCON response into a table; the Server Info tab uses the built-in `serverinfo` command; the Live Map's event markers use the built-in `find_entity` command - all tested against your actual server and working.
- Without a `rustmaps_api_key`, the Live Map tab still shows live player/event markers - just without the background map image. The very first time RustMaps sees a given seed/world size, generating the image can take a couple minutes; the tab shows a "generating" message and a Refresh button until it's ready.
- Without a `battlemetrics_id`, the Overview tab still shows everything else - Rank just stays blank.
- The Overview tab's background image is `app/static/img/bg.jpg` - swap that file for your own image (same filename) if you want something different than nor.workisboring.com's background.
- Several AMAP tab actions (Updater, Map Wipe, Full Wipe) stop the live Rust server, which is the very process the AmapBridge plugin runs inside - expect the RCON connection to drop right after using one of those, same as it would if you stopped the server any other way. The dashboard reconnects automatically once the server's back up.

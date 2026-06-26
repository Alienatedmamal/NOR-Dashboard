# NOR Dashboard

A simple admin dashboard for your Rust server: a live console feed, server info/settings, online/offline/banned player management with notes, permission management, player ban/Steam history lookups, a live map with player and world-event tracking, a password-protected AMAP scripts tab, and a wipe countdown. Same black-and-neon-green look as AMAP and nor.workisboring.com.

This doc covers one-time setup. Once it's running, see `ADMIN-GUIDE.md` for how to actually use each tab day-to-day.

## One-time setup

1. **Double-click `install.bat`.** It checks for Python and installs it automatically (via `winget`) if it's missing, then installs the three small packages this needs (Flask, websocket-client, requests), and creates `config.json` from the template if it doesn't already exist.
2. **Edit `config.json`** in this folder and fill in:
   - `rcon_host` - your Rust server's IP address
   - `rcon_port` - your RCON port (LGSM's `rcon.port`, default `28016`)
   - `rcon_password` - your RCON password (LGSM's `rcon.password`)
   - `steam_api_key` - a free key from https://steamcommunity.com/dev/apikey (Player Lookup tab, Rust hours, and player avatars)
   - `rustmaps_api_key` - a free key from https://rustmaps.com/dashboard (Live Map tab's background image - the rest of the Live Map tab works without it)
   - `amap_tab_password` - a password of your choosing, used only to gate the AMAP Scripts tab (see below)
3. Make sure this PC can actually reach your Rust server's RCON port (same network, or whatever your firewall/router allows).

## Running it

Double-click **`run.bat`**. It prints `Running on http://127.0.0.1:5050` and opens that page in your browser for you.

Leave the console window open while using the dashboard - closing it shuts the dashboard down. Next time, just double-click `run.bat` again (no need to re-run `install.bat`).

## What's in here

- **Console** - a live feed of everything your server logs (plugin loads, warnings, chat, command output...), same idea as RustAdmin's console. Type a command and its response shows up in the same feed within a second or two, interleaved with everything else.
- **Server Info** - live stats (players, map, framerate, uptime, entity count, etc.) and editable server settings (hostname, URL, description, header image), pre-filled with the current values.
- **Players** - online players (name, SteamID, IP, ping, session/total time, last connected, Rust hours) with one-click ban/unban (reason required and logged) and Look up; plus recently-seen offline players, currently-banned players, and a per-player notes log (ban reasons are added automatically).
- **Permissions** - grant/revoke an Oxide permission on a player or group, add/remove a player from a group, and check what permissions/groups a player or group currently has.
- **Player Lookup** - paste a SteamID64 to see their Steam profile, account age, VAC/game ban counts, and community/economy ban status.
- **Live Map** - your actual map image (via RustMaps.com) with live-updating markers for online players (avatar + name) and world events - cargo ship, patrol helicopter, Bradley APC, CH47, cargo plane. No plugin required; built entirely on vanilla RCON commands.
- **AMAP Scripts** - password-protected tab that runs a fixed set of your AMAP server-management scripts (backup, update plugins/server, map/full wipe, stop, nightly restart) over RCON - no SSH needed. See "AMAP Scripts setup" below for how this actually works.
- **Wipe countdown** - in the header, counting down to 2pm Central on the first Thursday of the month, DST-aware.

## AMAP Scripts setup

This tab needs a small custom Oxide plugin, `plugins/AmapBridge.cs`, installed on the server - it's what lets an RCON command actually run a shell script on the box. It's already deployed to your live server's `oxide/plugins/` folder; `plugins/AmapBridge.cs` in this repo is the source of truth if you ever need to redeploy it (e.g. after a fresh Oxide install) - just copy it back into `oxide/plugins/` and the server will compile and load it automatically within a few seconds.

The plugin only recognizes a fixed, hardcoded list of action keywords (see the `Actions` dictionary at the top of the file) - it never accepts or runs arbitrary shell text from RCON. Adding a new dashboard button means adding a new line to both that dictionary and `amap_commands.py`'s `AMAP_ACTIONS`, not changing what kind of input is accepted.

The tab's password (`amap_tab_password` in `config.json`) is checked on the server side on every single action request, not just to unlock the tab in the browser - so even if someone bypassed the UI and called the API directly, they'd still need the real password.

## Giving this to other admins

Copy the whole `NOR-Dashboard` folder to their PC (or zip it up).

- **`config.json`** holds your RCON password and API keys, including the AMAP Scripts tab password. If this admin already has (or should have) full RCON access and AMAP control anyway, it's fine to include as-is so they're up and running immediately. If not, delete it before sharing (or just don't include it) - `config.example.json` is the safe template that ships instead, and `install.bat` will recreate `config.json` from it.
- **`.pyexe`** and the **`__pycache__`** folder are machine-specific and safe to delete before sharing - both get regenerated automatically (`.pyexe` by `install.bat`, `__pycache__` the first time Python runs).
- **`player_notes.json`, `player_stats.json`, `map_cache.json`** hold this server's accumulated notes/ban reasons, player history, and cached map data. Leave them in if you want the other admin to see the same history; delete them for a clean slate.

Each admin then:

1. Double-clicks `install.bat` (sets up Python/packages and creates a fresh `config.json` for them if one isn't already there).
2. Fills in `config.json` with the same server details you use, if it wasn't already filled in.
3. Double-clicks `run.bat`.

## Notes

- This only binds to `127.0.0.1` (your own PC) - it's deliberately not reachable over your network, since `config.json` holds your RCON password.
- If the RCON connection drops or the server restarts, the dashboard reconnects automatically next time it needs to talk to it.
- The Players list parses your server's `playerlist` RCON response into a table; the Server Info tab uses the built-in `serverinfo` command; the Live Map's event markers use the built-in `find_entity` command - all tested against your actual server and working.
- Without a `rustmaps_api_key`, the Live Map tab still shows live player/event markers - just without the background map image. The very first time RustMaps sees a given seed/world size, generating the image can take a couple minutes; the tab shows a "generating" message and a Refresh button until it's ready.
- Several AMAP Scripts actions (Stop, Map Wipe, Full Wipe, Nightly Restart) stop the live Rust server, which is the very process the AmapBridge plugin runs inside - expect the RCON connection to drop right after using one of those, same as it would if you stopped the server any other way. The dashboard reconnects automatically once the server's back up.

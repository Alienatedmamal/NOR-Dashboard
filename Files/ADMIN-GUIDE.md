# NOR Dashboard - Admin Guide

This is the day-to-day "how do I do X" guide. For first-time setup (installing Python, filling in `app/config.json`), see `README.md` instead - this guide assumes that's already done and you've got the dashboard open in your browser.

## Getting in

Double-click `run.bat` in the dashboard folder. It runs in the background with no console window, and your browser opens to the dashboard automatically after a couple seconds. If it doesn't, go to `http://127.0.0.1:5050`. Closing that browser window is what shuts the dashboard down now (within about a minute and a half) - refreshing the page, switching tabs, or just leaving it in the background doesn't.

## Updating the dashboard

Easiest way, without leaving the browser: open **Settings > Update**, click **Check for Updates**, and if one's available, click **Update Now**. A pop-up confirms when it's done - close the dashboard's browser window and double-click `run.bat` again to actually start running the new version.

Or, when you're told a new version is out, double-click **`update.bat`** in the dashboard folder instead:

1. A console window opens and downloads the latest version from GitHub.
2. It overwrites the dashboard's files with the new version automatically - no git, no command line, nothing to install.
3. When it says "Update complete," close that window and double-click `run.bat` as usual.

Nothing you'd lose is touched by this: `app/config.json` (your settings/passwords), player notes, player stats, and the map cache all stay exactly as they were, since none of those are part of what gets downloaded.

You only need an internet connection for this step - once it's done, the dashboard runs the same as always, fully on your own PC.

## The header

- **Top left**: the server logo.
- **Center**: a countdown to the next wipe, based on whatever's set in Settings > Wipe Schedule (defaults to the first Thursday of the month, 2pm Central, until changed).
- **Top right**: current player count, a Connected/Not Connected badge, and when it was last checked. If it says "Not connected," the dashboard can't reach the server's RCON right now - it'll reconnect automatically once it can, no action needed from you.

## Overview tab

The first thing you see when you open the dashboard - a quick-glance summary of everything an admin would want to check first, with your site's background image behind it.

- **Hostname and description** at the top.
- **Stat cards**: Players (current/max), Queued, BattleMetrics Rank, Framerate, Game Time, Uptime, Map, and Entity Count.
- **Entity Count History**: a graph of entity count over time, sampled every 5 minutes. Entity count drives server load more than player count does, so this is the thing to watch for a buildup as a wipe approaches. It's local to this install - if the dashboard wasn't running for a stretch, that stretch just shows as a gap, and a brand-new install starts with an empty graph until a few samples come in.
- **Connected Players** at the bottom - the same live list shown in the Console tab's sidebar.

Most of this comes straight from RCON and updates every 15-20 seconds. BattleMetrics Rank comes from the public BattleMetrics API instead (no API key needed) and updates roughly every 30 seconds, since BattleMetrics' own crawler doesn't refresh a server's data much faster than that anyway. If Rank shows "-", check that `battlemetrics_id` is set in `app/config.json` (see `README.md`).

## Console tab

A live feed of everything the server logs - plugin messages, warnings, chat, and the response to any command you run - same idea as RustAdmin's console. Type a command in the box at the bottom and hit Send; its response shows up in the feed within a second or two, mixed in with everything else happening on the server.

Below the console input is **Broadcast Message**: sends a chat message to everyone currently connected - type it and hit Send, same as typing `say "your message"` directly, just without needing to know the command.

The sidebar next to it has two panels: **Give Item** on top - pick a connected player, an item from the list (grouped by category - Resources, Weapons, Ammo, etc., each with its icon), and a quantity, then click Give Item (only currently-connected players show up in the dropdown; the item list is a curated common-items set, not every item in the game - let whoever maintains the dashboard know if something you need is missing) - and below it, **Online Players**, listing who's currently connected with how long they've been on this session and a **Kick** button per player (you'll be prompted for an optional reason).

## Players tab

- **Online Players**: everyone currently connected, with SteamID, IP, ping, session time, total time on your server, last connected date, and lifetime Rust hours (pulled from Steam).
  - **Kick**: click the button next to a player - you'll be prompted for an optional reason, which gets saved to that player's notes automatically, same as a ban.
  - **Ban / Unban**: click the button next to a player. Banning requires a reason - you'll be prompted for one, and it gets saved to that player's notes automatically.
  - **Look up**: jumps to the Player Lookup tab with that SteamID already filled in.
  - **Notes**: jumps down to the Player Notes panel with that SteamID loaded.
- **Offline Players**: recently-seen players who aren't online right now, with the same Look up / Notes shortcuts. Shows each player's last-known IP alongside their name/SteamID, same as the Online Players table.
- **Banned Players**: everyone currently banned, with a one-click Unban.
- **Player Notes**: paste a SteamID (or use one of the Notes buttons above) and click Load Notes to see their history - ban reasons show up here automatically, and you can add your own free-text notes too. Each note has a Delete button.
  - **Search All Notes**: type a keyword (e.g. "cheating") and click Search to find it across every player's notes at once, not just one you already have a SteamID for - each result shows who it's about and a Notes button to jump straight to that player's full history.

Everything on this tab is automatically shared with any other admin running their own copy of the dashboard against the same server - notes sync the moment you add or delete one, and total time/last connected merge in every few minutes. There's nothing to set up for this; it rides on the same RCON connection the rest of the dashboard already uses. If a sync can't go through (the server's briefly unreachable, for example), you'll see a warning with the actual reason next to the notes it couldn't confirm, rather than it just silently not updating. See `README.md`'s "Shared player data" section if you're curious how it works under the hood.

If you don't want to wait for the next automatic merge, click **Force Sync** next to Load Notes - it pulls and pushes both notes and stats right away. You can only click it once every 10 seconds; clicking sooner shows a brief "have to wait" message that clears itself after a few seconds.

## Player Lookup tab

Paste any SteamID64 and click Look Up to see their Steam profile, avatar, account age, profile visibility, and VAC/game/community/economy ban status. Useful for vetting someone before letting them in, or checking a report against them.

## Live Map tab

Your actual server map, with live markers refreshed every few seconds:

- **Avatar + name** = an online player, at their real in-game position.
- **Colored dots** (see the legend above the map) = world events currently active: Cargo Ship, Patrol Helicopter, Bradley APC, CH47, Cargo Plane. If a dot isn't showing, that event simply isn't happening right now - it'll appear when one spawns.

Hover any marker to see its name/label. Click Refresh if the map image hasn't loaded yet (the very first time the server's seed is looked up, generating the image can take a couple of minutes - it'll show a "generating" message until it's ready).

## Permissions tab

Three independent panels:

- **Grant / Revoke Permission**: pick Player or Group, type their name/SteamID (or group name), type or pick a permission from the suggestions, then Grant or Revoke.
- **Add / Remove From Group**: pick a group from the dropdown (populated from your server's actual groups, not typed blind) and add or remove a player. Below it, **Create New Group** makes a brand new one (name required, title optional), and **Remove Group** deletes one entirely - pick it from the dropdown and confirm; this is permanent and also removes whatever permissions/members that group had. Both update the dropdown right after automatically.
- **Check Current Permissions**: pick Player or Group and a name, click Show, and it prints exactly what that player or group currently has.

All three name/SteamID fields let you click in and pick from currently-online players, or just type a SteamID/group name directly.

## Server Info tab

- **Server Settings**: edit your hostname, server URL, description, or header image. Each field loads with the current value - change it and click Apply next to that field, then confirm in the popup that appears.
- **Live Server Stats**: framerate, uptime, player count, entity count, etc. Click Refresh to update.

## Terminal tab

A real SSH terminal embedded in the page - for anything AMAP's fixed action list doesn't cover.

Fill in Host, Port (defaults to 22), Username, and Password, then click Connect. Once connected you get a genuine interactive shell - run any command, use arrow keys/tab-completion/Ctrl-C like a normal terminal, and the connection stays open as long as you're on the tab. Click Disconnect when you're done.

Nothing typed into this tab - host, username, or password - is ever written to `config.json` or any other file. It only exists in memory for the life of that one connection, same as typing a password into a normal terminal program.

## Help tab

A link out to this project's GitHub repo - more in-app guidance is planned for this tab later. Click **Show FAQ / Troubleshooting** above it for quick answers to common questions without leaving the dashboard.

## AMAP tab

Runs your actual AMAP server-management scripts remotely over RCON - no SSH access needed on your PC at all.

1. Each action is its own card with a description and a Critical/Noncritical tag. Click Run. You'll get a confirmation popup describing exactly what it does.
2. For Critical actions (red tag), you'll also be asked to type the action's exact name to confirm - this is intentional friction so a stray click can't take the server down or wipe data.
3. The result shows up in the small log box at the bottom of the tab.

What each card actually does:

| Card | Type | What it runs |
|---|---|---|
| Server Backup | Noncritical | Backs up all server data. |
| Log Cleaner | Noncritical | Clears the logs. |
| Server Checker | Noncritical | Checks if the server is running. If it fails to restart, posts an alert to Discord. |
| Wipe Configurator | Noncritical | Writes the config for the next wipe (seed, map size, wipe date, wipe type - you fill in the four fields on the card itself). Doesn't affect the live server; it only prepares what the *next* wipe will use. Has its own **View Current Config** button to see what's currently saved before you overwrite it - reports Seed, Map Size, Wipe Type, and Wipe Date as clearly labeled lines, never the RCON password or Discord webhook that also live in that file. |
| Updater | Critical | Updates the server. May stop the server. |
| Map Wipe | Critical | Wipes the map. Blueprints are kept. |
| Full Wipe | Critical | Full wipe - deletes the map and all player data. This cannot be undone. |

A few things worth knowing:

- The Wipe Configurator's four fields are validated before anything runs: Seed and Map Size must be plain numbers, Wipe Date must be MM-DD-YY (or MM-DD-YYYY), and Wipe Type must be exactly "BP" or "Map". It'll tell you exactly which field is wrong rather than silently failing.
- After a Critical action that stops the server (Updater, Map Wipe, Full Wipe), the dashboard's "Connected" badge will briefly flip to "Not connected" - that's expected, since the server you're talking to just went down. It reconnects automatically once the server's back up.
- These cards run the same underlying scripts as AMAP's own menu - nothing here does anything AMAP itself couldn't already do.

Below the cards, the **Upload Plugin** panel sends a `.cs` file straight to your server's `oxide/plugins` folder over SFTP - set the destination once in Settings > Plugin Deploy first (see `README.md` for the one-time SSH key setup this needs). The "Currently installed" dropdown is just for reference, so you can see what's already there before uploading something with the same name. Any permissions the plugin declares (`permission.RegisterPermission(...)`) are picked up automatically and show up in the Permissions tab's suggestions right after a successful upload - if a plugin registers permissions through a named constant instead of a plain string, those won't be auto-detected and need adding by hand.

## Settings (gear icon)

Six sub-pages along the top:

- **RCON**: edit the host/port/password the dashboard uses to talk to your Rust server. Click **Save & Reconnect** and it takes effect immediately - no need to restart the dashboard or touch `config.json` by hand.
- **API Keys**: the same Steam Web/RustMaps/BattleMetrics fields from one-time setup in `README.md`, editable here instead of by hand in `config.json`. All three are optional - leave any of them blank and the feature it powers (Player Lookup/Rust hours/avatars, the Live Map background image, or the Overview tab's Rank stat) just turns itself off until you fill it in. Saving applies immediately, no restart needed. The Steam Web and RustMaps key fields are masked like a password box - click into the field and select-all if you need to check what's currently saved.
- **Theme**: pick a preset from the dropdown to switch the whole dashboard's colors instantly, or use the four color pickers (Accent, Background, Text, Danger/Alerts) to build your own - the layout never changes, only colors. Both are just a live preview until you click **Save** - close the dashboard without saving and it'll go back to whatever was last saved (or the default green theme, if nothing ever was). **Reset to Default** previews the original green theme; click **Save** afterward to actually keep it. Saved in this dashboard's own `config.json`, not just your browser - so it looks the same in any browser tab pointed at *this* install. It is **not** synced to the Rust server the way player notes/stats are (see the Players tab section above) - a different admin running their own separate copy of the dashboard keeps their own independent theme.
- **Wipe Schedule**: controls the countdown shown in the header. Pick Daily, Bi-weekly (every 14 days from a date you set once), or Monthly (first Thursday), plus the time and timezone. Same as Theme - saved in this dashboard's own `config.json`, consistent across any browser tab pointed at *this* install, but not synced to the Rust server or shared with a different admin's separate dashboard copy.
- **Plugin Deploy**: the host/username/folder path the AMAP tab's Upload Plugin panel sends files to - see the AMAP section above and `README.md`'s SSH key setup steps.
- **Update**: click **Check for Updates** to see if a newer version is on GitHub; if so, **Update Now** appears - click it to download and install, same as running `update.bat` but without leaving the browser. A pop-up confirms when it's done and reminds you to restart `run.bat` - the page you're looking at keeps running the old code in memory until then, so don't expect it to look any different until you actually restart.

## Quick troubleshooting

- **"Not connected" badge won't clear**: check that the dashboard's PC can still reach the Rust server's RCON port - nothing else to do on the dashboard side, it retries automatically. If you just used an AMAP tab action that stops the server, give it a minute to come back up first.
- **A tab's data looks stale or empty**: most tabs have their own Refresh button - try that first.
- **A red pop-up appears in the bottom-right corner**: read its suggested fix, then click the × to dismiss it - it won't reappear on its own.
- **The dashboard closed itself / isn't responding**: just double-click `run.bat` again to relaunch it. (Closing its browser window is what shuts it down now, by design - see README.md.)
- **`run.bat` opens briefly, then a pop-up says the dashboard didn't start within 25 seconds**: open `dashboard.log` in the dashboard's main folder (the one with `run.bat` in it) and check the last few lines for the actual error.
- **`update.bat` says it failed**: check your internet connection first. If that's fine, let whoever maintains the dashboard know - it can also fail if the GitHub repo itself is temporarily unavailable, which isn't something fixable from your end.
- **Windows shows a blue "Windows protected your PC" warning** when double-clicking `run.bat`, `install.bat`, or `update.bat`: that just means the file came from the internet - click **More info**, then **Run anyway**. Nothing's wrong with the file.

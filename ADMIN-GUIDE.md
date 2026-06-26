# NOR Dashboard - Admin Guide

This is the day-to-day "how do I do X" guide. For first-time setup (installing Python, filling in `config.json`), see `README.md` instead - this guide assumes that's already done and you've got the dashboard open in your browser.

## Getting in

Double-click `run.bat` in the dashboard folder. A console window opens (leave it open - closing it shuts the dashboard down) and your browser opens to the dashboard automatically. If it doesn't, go to `http://127.0.0.1:5050`.

## Updating the dashboard

When you're told a new version is out, double-click **`update.bat`** in the dashboard folder.

1. A console window opens and downloads the latest version from GitHub.
2. It overwrites the dashboard's files with the new version automatically - no git, no command line, nothing to install.
3. When it says "Update complete," close that window and double-click `run.bat` as usual.

Nothing you'd lose is touched by this: `config.json` (your settings/passwords), player notes, player stats, and the map cache all stay exactly as they were, since none of those are part of what gets downloaded.

You only need an internet connection for this step - once it's done, the dashboard runs the same as always, fully on your own PC.

## The header

- **Top left**: the server logo.
- **Center**: a countdown to the next wipe (first Thursday of the month, 2pm Central).
- **Top right**: current player count, a Connected/Not Connected badge, and when it was last checked. If it says "Not connected," the dashboard can't reach the server's RCON right now - it'll reconnect automatically once it can, no action needed from you.

## Overview tab

The first thing you see when you open the dashboard - a quick-glance summary of everything an admin would want to check first, with your site's background image behind it.

- **Hostname and description** at the top.
- **Stat cards**: Players (current/max), Queued, BattleMetrics Rank, Framerate, Game Time, Uptime, Map, and Entity Count.
- **Connected Players** at the bottom - the same live list shown in the Console tab's sidebar.

Most of this comes straight from RCON and updates every 15-20 seconds. BattleMetrics Rank comes from the public BattleMetrics API instead (no API key needed) and updates roughly every 30 seconds, since BattleMetrics' own crawler doesn't refresh a server's data much faster than that anyway. If Rank shows "-", check that `battlemetrics_id` is set in `config.json` (see `README.md`).

## Console tab

A live feed of everything the server logs - plugin messages, warnings, chat, and the response to any command you run - same idea as RustAdmin's console. Type a command in the box at the bottom and hit Send; its response shows up in the feed within a second or two, mixed in with everything else happening on the server.

The sidebar next to it lists who's currently online, with how long they've been connected this session.

## Players tab

- **Online Players**: everyone currently connected, with SteamID, IP, ping, session time, total time on your server, last connected date, and lifetime Rust hours (pulled from Steam).
  - **Ban / Unban**: click the button next to a player. Banning requires a reason - you'll be prompted for one, and it gets saved to that player's notes automatically.
  - **Look up**: jumps to the Player Lookup tab with that SteamID already filled in.
  - **Notes**: jumps down to the Player Notes panel with that SteamID loaded.
- **Offline Players**: recently-seen players who aren't online right now, with the same Look up / Notes shortcuts.
- **Banned Players**: everyone currently banned, with a one-click Unban.
- **Player Notes**: paste a SteamID (or use one of the Notes buttons above) and click Load Notes to see their history - ban reasons show up here automatically, and you can add your own free-text notes too. Each note has a Delete button.

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
- **Add / Remove From Group**: add or remove a player from an Oxide group (e.g. `vip`, `admin`).
- **Check Current Permissions**: pick Player or Group and a name, click Show, and it prints exactly what that player or group currently has.

All three name/SteamID fields let you click in and pick from currently-online players, or just type a SteamID/group name directly.

## Server Info tab

- **Server Settings**: edit your hostname, server URL, description, or header image. Each field loads with the current value - change it and click Apply next to that field, then confirm in the popup that appears.
- **Live Server Stats**: framerate, uptime, player count, entity count, etc. Click Refresh to update.

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
| Wipe Configurator | Noncritical | Writes the config for the next wipe (seed, map size, wipe date, wipe type - you fill in the four fields on the card itself). Doesn't affect the live server; it only prepares what the *next* wipe will use. Has its own **View Current Config** button to see what's currently saved before you overwrite it - shows just the seed, map size, wipe type, and description, never the RCON password or Discord webhook that also live in that file. |
| Updater | Critical | Updates the server. May stop the server. |
| Nightly Restart | Critical | Just stops the server (deprecated, but still works). |
| Map Wipe | Critical | Wipes the map. Blueprints are kept. |
| Full Wipe | Critical | Full wipe - deletes the map and all player data. This cannot be undone. |

A few things worth knowing:

- The Wipe Configurator's four fields are validated before anything runs: Seed and Map Size must be plain numbers, Wipe Date must be MM-DD-YY (or MM-DD-YYYY), and Wipe Type must be exactly "BP" or "Map". It'll tell you exactly which field is wrong rather than silently failing.
- After a Critical action that stops the server (Updater, Nightly Restart, Map Wipe, Full Wipe), the dashboard's "Connected" badge will briefly flip to "Not connected" - that's expected, since the server you're talking to just went down. It reconnects automatically once the server's back up.
- These cards run the same underlying scripts as AMAP's own menu - nothing here does anything AMAP itself couldn't already do.

## Quick troubleshooting

- **"Not connected" badge won't clear**: check that the dashboard's PC can still reach the Rust server's RCON port - nothing else to do on the dashboard side, it retries automatically. If you just used an AMAP tab action that stops the server, give it a minute to come back up first.
- **A tab's data looks stale or empty**: most tabs have their own Refresh button - try that first.
- **Console window got closed by accident**: just double-click `run.bat` again.
- **`update.bat` says it failed**: check your internet connection first. If that's fine, let whoever maintains the dashboard know - it can also fail if the GitHub repo itself is temporarily unavailable, which isn't something fixable from your end.
- **Windows shows a blue "Windows protected your PC" warning** when double-clicking `run.bat`, `install.bat`, or `update.bat`: that just means the file came from the internet - click **More info**, then **Run anyway**. Nothing's wrong with the file.

# NOR Dashboard - Admin Guide

This is the day-to-day "how do I do X" guide. For first-time setup (installing Python, filling in `config.json`), see `README.md` instead - this guide assumes that's already done and you've got the dashboard open in your browser.

## Getting in

Double-click `run.bat` in the dashboard folder. A console window opens (leave it open - closing it shuts the dashboard down) and your browser opens to the dashboard automatically. If it doesn't, go to `http://127.0.0.1:5050`.

## The header

- **Top left**: the server logo.
- **Center**: a countdown to the next wipe (first Thursday of the month, 2pm Central).
- **Top right**: current player count, a Connected/Not Connected badge, and when it was last checked. If it says "Not connected," the dashboard can't reach the server's RCON right now - it'll reconnect automatically once it can, no action needed from you.

## Console tab

A live feed of everything the server logs - plugin messages, warnings, chat, and the response to any command you run - same idea as RustAdmin's console. Type a command in the box at the bottom and hit Send; its response shows up in the feed within a second or two, mixed in with everything else happening on the server.

The sidebar next to it lists who's currently online, with how long they've been connected this session.

## Server Info tab

- **Server Settings**: edit your hostname, server URL, description, or header image. Each field loads with the current value - change it and click Apply next to that field.
- **Live Server Stats**: framerate, uptime, player count, entity count, etc. Click Refresh to update.

## Players tab

- **Online Players**: everyone currently connected, with SteamID, IP, ping, session time, total time on your server, last connected date, and lifetime Rust hours (pulled from Steam).
  - **Ban / Unban**: click the button next to a player. Banning requires a reason - you'll be prompted for one, and it gets saved to that player's notes automatically.
  - **Look up**: jumps to the Player Lookup tab with that SteamID already filled in.
  - **Notes**: jumps down to the Player Notes panel with that SteamID loaded.
- **Offline Players**: recently-seen players who aren't online right now, with the same Look up / Notes shortcuts.
- **Banned Players**: everyone currently banned, with a one-click Unban.
- **Player Notes**: paste a SteamID (or use one of the Notes buttons above) and click Load Notes to see their history - ban reasons show up here automatically, and you can add your own free-text notes too. Each note has a Delete button.

## Permissions tab

Three independent panels:

- **Grant / Revoke Permission**: pick Player or Group, type their name/SteamID (or group name), type or pick a permission from the suggestions, then Grant or Revoke.
- **Add / Remove From Group**: add or remove a player from an Oxide group (e.g. `vip`, `admin`).
- **Check Current Permissions**: pick Player or Group and a name, click Show, and it prints exactly what that player or group currently has.

All three name/SteamID fields let you click in and pick from currently-online players, or just type a SteamID/group name directly.

## Player Lookup tab

Paste any SteamID64 and click Look Up to see their Steam profile, avatar, account age, profile visibility, and VAC/game/community/economy ban status. Useful for vetting someone before letting them in, or checking a report against them.

## Live Map tab

Your actual server map, with live markers refreshed every few seconds:

- **Avatar + name** = an online player, at their real in-game position.
- **Colored dots** (see the legend above the map) = world events currently active: Cargo Ship, Patrol Helicopter, Bradley APC, CH47, Cargo Plane. If a dot isn't showing, that event simply isn't happening right now - it'll appear when one spawns.

Hover any marker to see its name/label. Click Refresh if the map image hasn't loaded yet (the very first time the server's seed is looked up, generating the image can take a couple of minutes - it'll show a "generating" message until it's ready).

## AMAP Scripts tab

Runs your actual AMAP server-management scripts remotely over RCON - no SSH access needed on your PC at all. It's locked behind its own password (separate from anything else in the dashboard) since these actions can stop the live server or wipe data.

1. Enter the AMAP tab password and click Unlock. (Ask whoever set up the dashboard for this password if you don't have it - it's not the same as the RCON password.)
2. Click the action you want. You'll get a confirmation popup describing exactly what it does.
3. For the higher-risk actions (anything in red - Stop, Update Server, Map Wipe, Full Wipe, Nightly Restart), you'll also be asked to type the action's exact name to confirm - this is intentional friction so a stray click can't take the server down or wipe data.
4. The result shows up in the small log box at the bottom of the tab.

What each button actually does:

| Button | What it runs |
|---|---|
| Server Backup | Backs up Oxide, server, and LGSM files to a timestamped folder. Safe to run anytime. |
| Update Plugins | Updates Oxide and all installed plugins. |
| Update Server | Applies the latest Rust server update via SteamCMD. May stop the server. |
| Stop Server | Stops the live Rust server. |
| Nightly Restart | Stops the server for a scheduled restart - relies on the server's existing watchdog/cron to bring it back up, same as it normally does overnight. |
| Map Wipe | Deletes the current map only. Player blueprints/inventory are kept. |
| Full Wipe | Deletes the map AND all player data (blueprints, identities, state). This cannot be undone. |

A few things worth knowing:

- After Stop, a wipe, or Nightly Restart, the dashboard's "Connected" badge will briefly flip to "Not connected" - that's expected, since the server you're talking to just went down. It reconnects automatically once the server's back up.
- The password you type is sent to the server and re-checked on every single button click, not just once when you unlock the tab - so there's no persistent "logged in" state to worry about leaving open.
- These buttons run the same underlying scripts as AMAP's own menu - nothing here does anything AMAP itself couldn't already do.

## Quick troubleshooting

- **"Not connected" badge won't clear**: check that the dashboard's PC can still reach the Rust server's RCON port - nothing else to do on the dashboard side, it retries automatically. If you just used an AMAP Scripts action that stops the server, give it a minute to come back up first.
- **A tab's data looks stale or empty**: most tabs have their own Refresh button - try that first.
- **Console window got closed by accident**: just double-click `run.bat` again.

"""
Steam Web API helpers for the Player Lookup tab.
Requires a free API key from https://steamcommunity.com/dev/apikey
"""
import time

import requests

STEAM_API_BASE = "https://api.steampowered.com"


def get_player_summary(api_key, steamid):
    url = f"{STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/"
    resp = requests.get(url, params={"key": api_key, "steamids": steamid}, timeout=10)
    resp.raise_for_status()
    players = resp.json().get("response", {}).get("players", [])
    return players[0] if players else None


def get_player_bans(api_key, steamid):
    url = f"{STEAM_API_BASE}/ISteamUser/GetPlayerBans/v1/"
    resp = requests.get(url, params={"key": api_key, "steamids": steamid}, timeout=10)
    resp.raise_for_status()
    players = resp.json().get("players", [])
    return players[0] if players else None


def get_player_bans_batch(api_key, steamids):
    """Ban info for multiple SteamID64s in one request - Steam's own API
    accepts a comma-separated steamids param (confirmed against the docs,
    up to ~100 IDs per call), no per-ID requests needed. Returns
    {steamid: ban_info_dict}; a SteamID Steam doesn't recognize is simply
    absent from the result rather than erroring the whole batch."""
    if not steamids:
        return {}
    url = f"{STEAM_API_BASE}/ISteamUser/GetPlayerBans/v1/"
    resp = requests.get(url, params={"key": api_key, "steamids": ",".join(steamids)}, timeout=10)
    resp.raise_for_status()
    players = resp.json().get("players", [])
    return {p["SteamId"]: p for p in players if p.get("SteamId")}


# steamid -> (fetched_at, ban_info_dict_or_None). Module-level so it
# survives across requests within this process (ban status changes rarely
# enough that re-fetching it every single Players-tab refresh, for every
# player, would just be wasted Steam API calls).
_ban_cache = {}
BAN_CACHE_TTL_SECONDS = 15 * 60


def get_player_bans_cached(api_key, steamids):
    """Ban info for multiple SteamIDs, batching one Steam API call for
    whichever aren't already cached (or have gone stale) rather than
    fetching anything already known to be fresh. Returns
    {steamid: ban_info_dict}, missing a steamid entirely if Steam has no
    record of it."""
    now = time.time()
    result = {}
    to_fetch = []
    for sid in steamids:
        cached = _ban_cache.get(sid)
        if cached and now - cached[0] < BAN_CACHE_TTL_SECONDS:
            if cached[1] is not None:
                result[sid] = cached[1]
        else:
            to_fetch.append(sid)
    if to_fetch:
        fetched = get_player_bans_batch(api_key, to_fetch)
        for sid in to_fetch:
            info = fetched.get(sid)
            _ban_cache[sid] = (now, info)
            if info is not None:
                result[sid] = info
    return result


RUST_APP_ID = 252490  # the Rust game itself on Steam - not LGSM's server app ID (258550)


def get_rust_playtime_hours(api_key, steamid):
    """Lifetime hours played in Rust across all servers, via Steam. Returns
    None if the profile's game details are private or Rust isn't found."""
    url = f"{STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/"
    resp = requests.get(url, params={
        "key": api_key,
        "steamid": steamid,
        "include_played_free_games": 1,
        "format": "json",
    }, timeout=10)
    resp.raise_for_status()
    games = resp.json().get("response", {}).get("games", [])
    for g in games:
        if g.get("appid") == RUST_APP_ID:
            return round(g.get("playtime_forever", 0) / 60, 1)
    return None


def lookup_player(api_key, steamid):
    """Combined profile + ban info for one SteamID64."""
    summary = get_player_summary(api_key, steamid) or {}
    bans = get_player_bans(api_key, steamid) or {}

    account_created = summary.get("timecreated")
    account_age_days = int((time.time() - account_created) / 86400) if account_created else None

    return {
        "steamid": steamid,
        "name": summary.get("personaname"),
        "avatar": summary.get("avatarfull"),
        "profile_url": summary.get("profileurl"),
        "visibility_public": summary.get("communityvisibilitystate") == 3,
        "account_created": account_created,
        "account_age_days": account_age_days,
        "vac_banned": bans.get("VACBanned", False),
        "number_of_vac_bans": bans.get("NumberOfVACBans", 0),
        "days_since_last_ban": bans.get("DaysSinceLastBan"),
        "number_of_game_bans": bans.get("NumberOfGameBans", 0),
        "community_banned": bans.get("CommunityBanned", False),
        "economy_ban": bans.get("EconomyBan", "none"),
    }

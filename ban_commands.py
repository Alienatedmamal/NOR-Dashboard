"""
Ban/unban helpers using Rust's built-in console commands (vanilla, not
Oxide-specific).
"""
import re

# Matches SteamID64-shaped tokens (all individual Steam accounts start with
# 765611...) rather than assuming an exact banlist text layout, since the
# exact column/format isn't something to guess at - this works regardless.
_STEAMID_PATTERN = re.compile(r"\b765611\d{11}\b")


def get_banned_steamids(client):
    """Returns a set of currently-banned SteamID64 strings."""
    raw = client.send_command("banlist", quiet=True)
    return set(_STEAMID_PATTERN.findall(raw))


def ban_player(client, steamid, reason="Banned via NOR Dashboard"):
    return client.send_command(f'ban {steamid} "{reason}"')


def unban_player(client, steamid):
    return client.send_command(f"unban {steamid}")

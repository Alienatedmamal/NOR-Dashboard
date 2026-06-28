"""
Player moderation/admin action helpers using Rust's built-in console
commands (vanilla, not Oxide-specific): ban/unban/kick, broadcasting a
chat message, and giving an item to a connected player.
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


def kick_player(client, steamid, reason=""):
    reason = reason or "Kicked via NOR Dashboard"
    return client.send_command(f'kick {steamid} "{reason}"')


def broadcast_message(client, message):
    return client.send_command(f'say "{message}"')


def give_item(client, steamid, shortname, amount):
    return client.send_command(f'inventory.giveto "{steamid}" "{shortname}" {amount}')

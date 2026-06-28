"""
Thin wrappers around the standard Oxide/uMod RCON console commands for
managing permissions and groups. These commands are stable across modern
Oxide installs.
"""
import time


def grant_permission(client, target_type, target, permission):
    target_type = "group" if target_type == "group" else "user"
    return client.send_command(f'oxide.grant {target_type} "{target}" "{permission}"')


def revoke_permission(client, target_type, target, permission):
    target_type = "group" if target_type == "group" else "user"
    return client.send_command(f'oxide.revoke {target_type} "{target}" "{permission}"')


def add_user_to_group(client, user, group):
    return client.send_command(f'oxide.usergroup add "{user}" "{group}"')


def remove_user_from_group(client, user, group):
    return client.send_command(f'oxide.usergroup remove "{user}" "{group}"')


def show_user(client, user):
    return client.send_command(f'oxide.show user "{user}"')


def show_group(client, group):
    return client.send_command(f'oxide.show group "{group}"')


def create_group(client, group, title=""):
    if title:
        return client.send_command(f'oxide.group add "{group}" "{title}"')
    return client.send_command(f'oxide.group add "{group}"')


def remove_group(client, group):
    return client.send_command(f'oxide.group remove "{group}"')


def list_groups(client):
    return client.send_command("oxide.show groups")


def parse_group_names(raw):
    """Parses 'oxide.show groups' output into a clean list of names - the
    real format is '[Oxide] HH:MM [Info] Groups:\\nname1, name2, name3', so
    the names are always on the last line, comma-separated."""
    lines = (raw or "").strip().splitlines()
    if not lines:
        return []
    return [name.strip() for name in lines[-1].split(",") if name.strip()]


def list_group_names(client):
    """list_groups() above hits the live server fresh every time, which
    surfaced a real flakiness in testing: 'oxide.show groups' intermittently
    comes back as an empty string even though the server genuinely has
    groups (looks like the real listing and an earlier near-empty ack share
    the same RCON response identifier, and whichever arrives first is what
    gets captured) - and confirmed worse than a one-off: right after a
    group-mutating command on the same connection, it can take a couple of
    tries in a row before a real response comes back. Retries up to 3 times
    total, with a brief pause between attempts (not before the first) to
    give the connection a moment to settle rather than hammering it."""
    for attempt in range(3):
        if attempt > 0:
            time.sleep(0.5)
        names = parse_group_names(list_groups(client))
        if names:
            return names
    return names

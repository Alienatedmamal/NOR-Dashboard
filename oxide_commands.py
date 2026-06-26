"""
Thin wrappers around the standard Oxide/uMod RCON console commands for
managing permissions and groups. These commands are stable across modern
Oxide installs.
"""


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


def list_groups(client):
    return client.send_command("oxide.show groups")

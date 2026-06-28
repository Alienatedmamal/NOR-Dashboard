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
    return _show_with_retry(client, f'oxide.show user "{user}"')


def show_group(client, group):
    return _show_with_retry(client, f'oxide.show group "{group}"')


def _show_with_retry(client, command):
    """The real fix for the empty-reply flakiness these commands used to
    hit lives in rcon_client.py's _reader_loop (a genuine race between two
    server messages sharing one Identifier, not just bad luck) - this
    retry is just a cheap defensive backstop in case anything still slips
    through (e.g. under real network/server load this quick local testing
    didn't reproduce), not the primary defense anymore."""
    response = ""
    for attempt in range(3):
        if attempt > 0:
            time.sleep(0.5)
        response = client.send_command(command)
        if response and response.strip():
            return response
    return response


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
    originally surfaced a real flakiness in testing: 'oxide.show groups'
    intermittently came back as an empty string even though the server
    genuinely has groups. Root cause confirmed and fixed in
    rcon_client.py's _reader_loop - the real listing and a second, empty
    acknowledgement both arrive tagged with the same RCON response
    Identifier, and without popping the pending waiter atomically on the
    first match, the second message could race in and overwrite the real
    one before send_command() read it. This retry now just a cheap
    defensive backstop, not the primary fix."""
    for attempt in range(3):
        if attempt > 0:
            time.sleep(0.5)
        names = parse_group_names(list_groups(client))
        if names:
            return names
    return names

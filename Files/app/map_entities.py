"""
Live world-event positions (cargo ship, patrol helicopter, Bradley APC,
CH47, cargo plane), read via Rust's built-in `find_entity` console command.

No installed plugin - including AdminRadar.cs, which tracks all of these
internally for its in-game overlay - exposes this data through any
console/chat command or external API (confirmed by grepping its source for
ConsoleCommand/RegisterCommand: zero matches). `find_entity` is vanilla
Rust and was confirmed against the live server to return real position
data for these entity types.

Player positions don't need any of this - they're already in playerlist's
own Position field (see rcon_client.get_players).
"""
import re

# search term -> display label. find_entity does a substring match against
# its "name" column, so a broad term like "player" matches unrelated things
# too (e.g. "cardgameplayerstorage" - confirmed against a real server).
# These are specific enough to stay clean.
EVENT_SEARCHES = {
    "cargoship": "Cargo Ship",
    "patrolhelicopter": "Patrol Helicopter",
    "bradleyapc": "Bradley APC",
    "ch47": "CH47 (Chinook)",
    "cargoplane": "Cargo Plane",
}

# Matches a find_entity data row, e.g.:
# sv    3683616 272631054 0      bradleyapc (0.02, 32.56, 478.75) (0.02, 32.56, 478.75) ...
# Captures the entity's "name" column and the first (x, y, z) triple, which
# is the "position" column - world space when there's no parent entity,
# which is all that's relevant for plotting on the map.
_ROW_PATTERN = re.compile(
    r"^sv\s+\d+\s+\S+\s+\S+\s+(\S+).*?\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)"
)

# "ch47" also substring-matches a couple of static, monument-anchored
# helper entities that have nothing to do with an actual flying Chinook
# (confirmed against a real server: "alarmsytstem" and
# "reinforcementslistener" turn up at fixed monument locations even with no
# CH47 event active). Excluded by name so a CH47 marker only ever means an
# actual helicopter.
#
# "bradleyapc" substring-matches "bradleyapc_corpse" (the wreck entity left
# behind after a Bradley is destroyed). Corpses persist for ~30 minutes and
# accumulate across events, so without this exclusion every past Bradley
# kill shows as an active Bradley icon on the map.
_NAME_EXCLUDE = {"alarmsytstem", "reinforcementslistener", "bradleyapc_corpse"}


def _parse_find_entity(raw, label):
    results = []
    for line in raw.splitlines():
        match = _ROW_PATTERN.match(line.strip())
        if not match:
            continue
        name, x, y, z = match.groups()
        if name in _NAME_EXCLUDE:
            continue
        results.append({
            "label": label,
            "name": name,
            "x": float(x),
            "y": float(y),
            "z": float(z),
        })
    return results


def get_world_events(client):
    """One find_entity round trip per tracked event type. Fine at this
    scale (5 searches) polled every several seconds - not meant to be
    hammered any faster than that."""
    events = []
    for term, label in EVENT_SEARCHES.items():
        raw = client.send_command(f"find_entity {term}", quiet=True)
        events.extend(_parse_find_entity(raw, label))
    return events

"""
Background map image, from RustMaps.com (https://rustmaps.com/dashboard
for an API key) - looked up by the world seed + size read straight from
the live server's own convars, so it automatically follows wipes without
needing to be told anything changed.

Cached to a local file keyed by seed+size: the image for a given seed/size
never changes, and RustMaps can take a couple minutes to generate a map
it's never seen before, so there's no reason to ask twice.

API confirmed against RustMaps' own public Swagger spec
(api.rustmaps.com/swagger/v4-public/swagger.json):
  GET  /v4/maps/{size}/{seed}?staging=false  -> 200 ready, 404 unknown
       (need to request generation), 409 still generating
  POST /v4/maps  {size, seed, staging}       -> kicks off generation
Auth: header "X-API-Key: <key>" on both.
"""
import json
import os

import requests

from server_info import get_convar

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(BASE_DIR, "map_cache.json")
API_BASE = "https://api.rustmaps.com/v4"


def get_world_seed_size(client):
    seed = get_convar(client, "server.seed")
    size = get_convar(client, "server.worldsize")
    return seed, size


def _load_cache():
    if not os.path.exists(CACHE_PATH):
        return {}
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return {}


def _save_cache(data):
    tmp_path = CACHE_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp_path, CACHE_PATH)


def _api_request(method, path, api_key, body=None):
    try:
        resp = requests.request(
            method, f"{API_BASE}{path}", json=body,
            headers={"X-API-Key": api_key}, timeout=15,
        )
    except requests.RequestException as exc:
        return None, {"error": str(exc)}
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {}


OIL_RIG_TYPES = {"Small Oilrig", "Large Oilrig"}


def _extract_oil_rigs(data):
    """RustMaps' monument list uses the same world-space coordinates as the
    server's own RCON (confirmed against a live server: a `find_entity
    oilrig` hit landed within ~30 units of the matching monument here) -
    its "y" is this app's "z" (the horizontal-plane coordinate everywhere
    else in this app calls z, since x/z is the ground plane and y is
    height). Only oil rigs are pulled out here since that's the one
    monument type the Live Map actually plots - not a general monument
    layer."""
    rigs = []
    for m in data.get("monuments") or []:
        if m.get("type") not in OIL_RIG_TYPES:
            continue
        coords = m.get("coordinates") or {}
        if coords.get("x") is None or coords.get("y") is None:
            continue
        rigs.append({"type": m["type"], "x": coords["x"], "z": coords["y"]})
    return rigs


def get_map_image(client, api_key):
    """Returns {"status": "ready"|"generating"|"error", ...}. "ready" comes
    with image_url and oil_rigs; "generating" means RustMaps is building
    this seed/size for the first time (poll again in a bit); "error" comes
    with a message fit to show directly in the UI."""
    seed, size = get_world_seed_size(client)
    if not seed or not size:
        return {"status": "error", "error": "Could not read server.seed / server.worldsize from the server"}

    cache = _load_cache()
    key = f"{size}_{seed}"
    cached = cache.get(key)
    if cached and cached.get("status") == "ready" and "oil_rigs" in cached:
        return cached

    if not api_key or api_key == "CHANGE_ME":
        return {"status": "error", "error": "Add your RustMaps API key in Settings > API Keys first", "seed": seed, "size": size}

    status, payload = _api_request("GET", f"/maps/{size}/{seed}?staging=false", api_key)

    if status == 200:
        data = (payload or {}).get("data") or {}
        result = {
            "status": "ready",
            "seed": seed,
            "size": size,
            "image_url": data.get("imageUrl"),
            "oil_rigs": _extract_oil_rigs(data),
        }
        cache[key] = result
        _save_cache(cache)
        return result

    if status == 404:
        # RustMaps hasn't generated this seed/size before - ask it to.
        _api_request("POST", "/maps", api_key, body={"size": int(size), "seed": int(seed), "staging": False})
        return {"status": "generating", "seed": seed, "size": size}

    if status == 409:
        return {"status": "generating", "seed": seed, "size": size}

    if status == 401 or status == 403:
        return {"status": "error", "error": "RustMaps rejected the API key", "seed": seed, "size": size}

    error = (payload or {}).get("error") or f"RustMaps API returned {status}"
    return {"status": "error", "error": error, "seed": seed, "size": size}

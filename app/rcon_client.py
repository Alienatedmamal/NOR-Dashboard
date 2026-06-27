"""
WebRcon client for Rust dedicated servers.

Rust exposes RCON over a WebSocket at ws://<ip>:<rcon_port>/<rcon_password>.
The same connection carries two kinds of messages: direct responses to
commands you send (matched back by Identifier) AND a continuous stream of
everything the server logs (plugin loads, warnings, chat, etc.), broadcast
to every connected client. A single background thread owns the socket's
recv() calls and routes each incoming message to whichever pending command
is waiting on it, while also appending every message to a rolling buffer
so the dashboard can show a live, RustAdmin-style console feed.
"""
import json
import threading
import time
from collections import deque

import websocket


class RconError(Exception):
    pass


# Module-level (not per-RconClient) so the live console feed survives a
# reconnect or a reset_rcon_client() call - those replace the RconClient
# instance on any transient error, and the log would otherwise silently
# get wiped and restart from empty every time that happens.
_log = deque(maxlen=1000)
_log_lock = threading.Lock()
_log_seq = 0


def _append_log(message):
    global _log_seq
    if not message:
        return
    with _log_lock:
        _log_seq += 1
        _log.append((_log_seq, time.strftime("%H:%M:%S"), message))


def get_log_since(after_seq=0):
    """Returns (lines, latest_seq). lines is [(seq, timestamp, message), ...]
    newer than after_seq - used to poll the live console feed incrementally."""
    with _log_lock:
        lines = [item for item in _log if item[0] > after_seq]
        latest = _log_seq
    return lines, latest


def get_log_tail(n=20):
    """Returns (lines, latest_seq) for just the most recent n lines - used
    to seed the console with recent history when a page first loads."""
    with _log_lock:
        lines = list(_log)[-n:]
        latest = _log_seq
    return lines, latest


class RconClient:
    def __init__(self, host, port, password, timeout=8):
        self.host = host
        self.port = port
        self.password = password
        self.timeout = timeout

        self._ws = None
        self._send_lock = threading.Lock()
        self._next_id = 1

        self._pending = {}
        self._pending_lock = threading.Lock()

    def _ensure_connected(self):
        if self._ws is not None:
            return
        url = f"ws://{self.host}:{self.port}/{self.password}"
        ws = websocket.create_connection(url, timeout=self.timeout)
        # The line above uses self.timeout just to fail fast if the server
        # is genuinely unreachable. Once connected, clear the socket timeout
        # entirely - otherwise the background reader thread's recv() call
        # raises a timeout (and the whole connection gets torn down and
        # rebuilt) any time the server goes quiet for longer than that, even
        # though nothing is actually wrong. send_command()'s own wait() call
        # below already enforces "give up after N seconds" for a specific
        # command's response, independently of this.
        ws.settimeout(None)
        self._ws = ws
        threading.Thread(target=self._reader_loop, args=(ws,), daemon=True).start()

    def _reader_loop(self, ws):
        while True:
            try:
                raw = ws.recv()
            except Exception:
                break
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                continue

            ident = data.get("Identifier")
            message = data.get("Message", "")

            quiet = False
            if ident:
                with self._pending_lock:
                    waiter = self._pending.get(ident)
                if waiter is not None:
                    waiter["message"] = message
                    quiet = waiter.get("quiet", False)
                    waiter["event"].set()

            if not quiet:
                _append_log(message)

        if self._ws is ws:
            self._ws = None
        with self._pending_lock:
            for waiter in self._pending.values():
                waiter["event"].set()

    def send_command(self, message, quiet=False):
        """Send one RCON command and return the server's text response.
        quiet=True keeps the response out of the live console feed - used
        for the periodic connection check, which isn't something you typed
        or care to see scroll by."""
        with self._send_lock:
            last_error = None
            for _attempt in range(2):
                try:
                    self._ensure_connected()

                    ident = self._next_id
                    self._next_id += 1
                    waiter = {"event": threading.Event(), "message": None, "quiet": quiet}
                    with self._pending_lock:
                        self._pending[ident] = waiter

                    payload = json.dumps({"Identifier": ident, "Message": message, "Name": "WebRcon"})
                    self._ws.send(payload)

                    got = waiter["event"].wait(self.timeout)
                    with self._pending_lock:
                        self._pending.pop(ident, None)

                    if not got:
                        raise RconError("Timed out waiting for a response from the server")
                    if waiter["message"] is None:
                        raise RconError("Connection closed before a response was received")
                    return waiter["message"]
                except (OSError, websocket.WebSocketException) as exc:
                    last_error = exc
                    self._ws = None
                    continue
            raise RconError(f"Could not reach the RCON server: {last_error}")

    def close(self):
        with self._send_lock:
            if self._ws is not None:
                try:
                    self._ws.close()
                except Exception:
                    pass
                self._ws = None


def get_players(client):
    """Returns (players, raw, ok). ok is False only if the response couldn't
    be parsed as a JSON list (as opposed to parsing fine into an empty
    list, i.e. nobody online) - raw holds the unparsed text either way."""
    raw = client.send_command("playerlist", quiet=True)
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return data, raw, True
    except (ValueError, TypeError):
        pass
    return [], raw, False

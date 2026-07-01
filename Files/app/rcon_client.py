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

_chat = deque(maxlen=500)
_chat_lock = threading.Lock()
_chat_seq = 0


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


def _append_chat(ts, player_name, steamid, message):
    global _chat_seq
    with _chat_lock:
        _chat_seq += 1
        _chat.append((_chat_seq, ts, player_name, steamid, message))


def get_chat_since(after_seq=0):
    """Returns (entries, latest_seq) for chat messages newer than after_seq."""
    with _chat_lock:
        entries = [item for item in _chat if item[0] > after_seq]
        latest = _chat_seq
    return entries, latest


def get_chat_tail(n=100):
    """Returns (entries, latest_seq) for the most recent n chat messages."""
    with _chat_lock:
        entries = list(_chat)[-n:]
        latest = _chat_seq
    return entries, latest


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
        # websocket-client's own timeout= doesn't reliably bound the
        # handshake-read phase if the server accepts the TCP connection but
        # is too busy to actually complete the WebSocket upgrade (observed
        # against a live, heavily-loaded Rust server: raw TCP connect was
        # instant, but create_connection() itself still hung well past the
        # timeout it was given). That hang holds _send_lock the whole time,
        # freezing every other RCON-backed feature in the dashboard too,
        # not just this one call. Running the attempt on a daemon thread
        # with a hard join(timeout) is a guaranteed backstop regardless of
        # whether the library's own timeout handling covers every phase of
        # the handshake - daemon=True means an abandoned, still-stuck
        # attempt can never block process shutdown either.
        result = {}

        def _connect():
            try:
                result["ws"] = websocket.create_connection(url, timeout=self.timeout)
            except Exception as exc:
                result["error"] = exc

        connect_thread = threading.Thread(target=_connect, daemon=True)
        connect_thread.start()
        connect_thread.join(self.timeout)
        if connect_thread.is_alive():
            raise TimeoutError("Timed out connecting to the RCON server")
        if "error" in result:
            raise result["error"]
        ws = result["ws"]
        # Once connected, clear the socket timeout entirely - otherwise the
        # background reader thread's recv() call raises a timeout (and the
        # whole connection gets torn down and rebuilt) any time the server
        # goes quiet for longer than that, even though nothing is actually
        # wrong. send_command()'s own wait() call below already enforces
        # "give up after N seconds" for a specific command's response,
        # independently of this.
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
            msg_type = data.get("Type", "")

            if msg_type == "Chat":
                ts = time.strftime("%H:%M:%S")
                player_name, steamid, chat_text = "", "", message
                try:
                    inner = json.loads(message)
                    player_name = inner.get("Username", "")
                    steamid = str(inner.get("UserId", ""))
                    chat_text = inner.get("Message", "")
                except (ValueError, TypeError):
                    if " : " in message:
                        player_name, _, chat_text = message.partition(" : ")
                _append_chat(ts, player_name.strip(), steamid.strip(), chat_text.strip())

            quiet = False
            if ident:
                # Pop (not just look up) the moment the first message for
                # this Identifier arrives. Some commands (oxide.show
                # user/group/groups, confirmed by testing) send the real
                # response immediately followed by a second, empty
                # acknowledgement that reuses the same Identifier - without
                # popping here, that second message can overwrite
                # waiter["message"] with the empty one before send_command()
                # (woken by the first message's event.set()) gets a chance
                # to read it, a genuine race since both run on different
                # threads. Removing the entry atomically with the first
                # match means any later message sharing that Identifier
                # finds nothing pending and just falls through to the
                # general log below instead of corrupting an already-
                # answered request.
                with self._pending_lock:
                    waiter = self._pending.pop(ident, None)
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
            self._pending.clear()

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
                    # _ensure_connected() leaves this socket with no timeout
                    # at all (see its comment - needed so the reader
                    # thread's recv() doesn't spuriously time out during
                    # quiet periods), but that also means send() itself
                    # could otherwise block forever if the server's TCP
                    # buffers back up under load (observed against a live,
                    # heavily-loaded Rust server - this was the actual
                    # cause of the dashboard freezing entirely, not the
                    # connection step). Bound just this one send() call,
                    # then immediately restore "no timeout" for the
                    # reader thread's ongoing recv() calls.
                    self._ws.settimeout(self.timeout)
                    try:
                        self._ws.send(payload)
                    finally:
                        self._ws.settimeout(None)

                    got = waiter["event"].wait(self.timeout)
                    # No pop needed here on the success path - _reader_loop
                    # already removed this entry from self._pending the
                    # moment it matched the first message (see its comment),
                    # which is what makes waiter["message"] safe to read
                    # without a race. Only the timeout case below still
                    # needs cleanup, since nothing ever arrived to pop it.
                    if not got:
                        with self._pending_lock:
                            self._pending.pop(ident, None)
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

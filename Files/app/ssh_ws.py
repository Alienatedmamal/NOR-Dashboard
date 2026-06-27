"""
WebSocket bridge for the Terminal tab - the dashboard's first WebSocket
route; every other feature is plain HTTP polling (see app.py). One
WebSocket connection backs exactly one SshTerminalSession (see
ssh_terminal.py); closing either side - browser tab, Disconnect button, or
the remote shell exiting - tears the SSH session down.

Wire protocol, JSON text frames:
  browser -> server: {"type": "connect", host, port, username, password,
                       cols, rows}, {"type": "data", "data": "<keystrokes>"},
                      {"type": "resize", cols, rows}
  server -> browser: {"type": "data", "data": "<remote output>"},
                      {"type": "status", "state": "connected"|"closed"|"error",
                       "message": "..."}
"""
import json
import threading

from ssh_terminal import SshTerminalError, SshTerminalSession


def register(sock):
    @sock.route("/ws/terminal")
    def ws_terminal(ws):
        session = SshTerminalSession()
        stop_event = threading.Event()

        def pump_output():
            """Runs in its own thread for the life of the SSH session,
            forwarding remote output to the browser as it arrives - the
            main loop below is busy blocking on ws.receive() for input."""
            while not stop_event.is_set():
                try:
                    data = session.read()
                except Exception:
                    break
                if not data:
                    break
                if not _send(ws, {"type": "data", "data": data.decode("utf-8", errors="replace")}):
                    break
            if not stop_event.is_set():
                _send(ws, {"type": "status", "state": "closed", "message": "Connection to the remote host closed."})

        try:
            while True:
                raw = ws.receive()
                if raw is None:
                    break
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue

                msg_type = msg.get("type")
                if msg_type == "connect":
                    try:
                        session.connect(
                            msg.get("host", ""),
                            int(msg.get("port") or 22),
                            msg.get("username", ""),
                            msg.get("password", ""),
                            int(msg.get("cols") or 80),
                            int(msg.get("rows") or 24),
                        )
                    except SshTerminalError as exc:
                        _send(ws, {"type": "status", "state": "error", "message": str(exc)})
                        continue
                    _send(ws, {"type": "status", "state": "connected"})
                    threading.Thread(target=pump_output, daemon=True).start()
                elif msg_type == "data" and not session.closed():
                    session.send(msg.get("data", ""))
                elif msg_type == "resize" and not session.closed():
                    session.resize(int(msg.get("cols") or 80), int(msg.get("rows") or 24))
        except Exception:
            pass
        finally:
            stop_event.set()
            session.close()


def _send(ws, payload):
    try:
        ws.send(json.dumps(payload))
        return True
    except Exception:
        return False

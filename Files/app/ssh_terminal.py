"""
SSH terminal sessions for the Terminal tab.

Wraps paramiko in the bare minimum needed to back a real interactive shell:
connect with whatever host/user/password the browser sent, open a PTY-backed
channel, and hand back a byte stream that ssh_ws.py pumps to/from a
WebSocket. Host keys are auto-accepted (no known_hosts UI exists here) since
the user is typing a fresh destination each time, same trust model as the
RCON connection's own lack of transport auth.
"""
import paramiko


class SshTerminalError(Exception):
    pass


class SshTerminalSession:
    def __init__(self):
        self._client = None
        self._channel = None

    def connect(self, host, port, username, password, cols, rows, timeout=10):
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                hostname=host,
                port=port,
                username=username,
                password=password,
                timeout=timeout,
                allow_agent=False,
                look_for_keys=False,
            )
            channel = client.invoke_shell(term="xterm-256color", width=cols, height=rows)
        except Exception as exc:
            client.close()
            raise SshTerminalError(str(exc)) from exc

        self._client = client
        self._channel = channel

    def read(self, nbytes=4096):
        """Blocks until at least one byte is available, or returns b"" once
        the remote end has closed the channel."""
        return self._channel.recv(nbytes)

    def send(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._channel.send(data)

    def resize(self, cols, rows):
        if self._channel is not None:
            self._channel.resize_pty(width=cols, height=rows)

    def closed(self):
        return self._channel is None or self._channel.closed

    def close(self):
        if self._channel is not None:
            try:
                self._channel.close()
            except Exception:
                pass
            self._channel = None
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

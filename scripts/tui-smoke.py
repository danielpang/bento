#!/usr/bin/env python3
"""Boot the built TUI against a disposable PostgreSQL database.

Run from the repository root after building @bento/tui:
  DATABASE_URL=postgres://... python3 scripts/tui-smoke.py
No agents are started. The TUI applies migrations to the supplied database.
"""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")


def main():
    database = os.environ.get("DATABASE_URL")
    if not database:
        raise RuntimeError("Set DATABASE_URL to a disposable PostgreSQL database.")
    cli = ROOT / "apps/tui/dist/cli.js"
    if not cli.exists():
        raise RuntimeError("Build the TUI first: pnpm exec turbo run build --filter=@bento/tui...")
    results = ROOT / "tui-smoke-results"
    results.mkdir(exist_ok=True)
    transcript = bytearray()
    with tempfile.TemporaryDirectory(prefix="bento-tui-smoke-") as temporary:
        data = Path(temporary) / "data"
        # An explicit loopback port lets us check the same API the board uses.
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
        env = {key: value for key, value in os.environ.items() if not key.startswith("BENTO_")}
        env.update({"TERM": "xterm-256color", "FORCE_COLOR": "1", "BENTO_SHARE_AGENT_AUTH": "false"})
        # Ink normally suppresses interactive rendering in CI. This child has a
        # real PTY and must exercise the same screen and keyboard path as users.
        env.update({"CI": "false", "CONTINUOUS_INTEGRATION": "false"})
        env.pop("NO_COLOR", None)
        env.pop("INK_SCREEN_READER", None)
        process = None
        try:
            process = subprocess.Popen(
                ["node", str(cli), "--db", database, "--data-dir", str(data),
                 "--port", str(port), "--sandbox", "local-process"],
                stdin=slave, stdout=slave, stderr=slave, cwd=temporary,
                env=env, start_new_session=True,
            )
            os.close(slave)
            slave = None

            def read_terminal():
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        transcript.extend(os.read(master, 65536))
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise

            def wait_for(*phrases, since=0, timeout=60):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    read_terminal()
                    if process.poll() is not None:
                        raise RuntimeError(f"TUI exited early with status {process.returncode}.")
                    text = ANSI.sub("", transcript[since:].decode("utf-8", errors="replace"))
                    if "Could not start Bento on this machine." in text:
                        raise RuntimeError("TUI startup failed. See tui-smoke-results/terminal.txt.")
                    if all(phrase in text for phrase in phrases):
                        return
                raise RuntimeError(f"TUI did not display {phrases} within {timeout} seconds.")

            wait_for("KANBAN", "Backlog", "Completed", "[Settings]", "[Quit]")
            if b"\x1b[?1049h" not in transcript:
                raise RuntimeError("TUI did not enter the alternate terminal screen.")
            with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as response:
                health = json.load(response)
            if health.get("mode") != "local":
                raise RuntimeError(f"Embedded server reported unexpected health: {health}")
            print("PASS: embedded server started, migrations applied, and Kanban rendered.", flush=True)

            offset = len(transcript)
            os.write(master, b",")
            wait_for("Repositories", "Agents", "Back to board", since=offset, timeout=15)
            offset = len(transcript)
            os.write(master, b"\x1b")
            wait_for("KANBAN", "[Quit]", since=offset, timeout=15)
            print("PASS: keyboard input opens Settings and returns to the board.", flush=True)

            os.write(master, b"q")
            deadline = time.monotonic() + 20
            while process.poll() is None and time.monotonic() < deadline:
                read_terminal()
            read_terminal()
            if process.poll() is None:
                raise RuntimeError("TUI did not exit after pressing q.")
            if process.returncode != 0:
                raise RuntimeError(f"TUI exited with status {process.returncode}.")
            if b"\x1b[?1049l" not in transcript:
                raise RuntimeError("TUI did not restore the terminal screen on exit.")
            print("PASS: q stopped the embedded server and exited cleanly.", flush=True)
        finally:
            if process is not None and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            if slave is not None:
                os.close(slave)
            os.close(master)
            (results / "terminal.ansi").write_bytes(transcript)
            (results / "terminal.txt").write_text(ANSI.sub("", transcript.decode("utf-8", errors="replace")))
            log = data / "logs/tui.log"
            if log.exists():
                shutil.copyfile(log, results / "tui.log")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}", flush=True)
        raise SystemExit(1)

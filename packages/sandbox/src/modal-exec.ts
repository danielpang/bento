import type { ExecChunk } from "./driver.js";

/**
 * The program baked into a Modal image at /usr/local/bin/bento-exec.
 *
 * `exec` keeps running after the client that started it is gone, and
 * there is no SDK call that reattaches to an old exec stream. This
 * program daemonizes the command, writes stdout and stderr as frames
 * from the first byte, and lets a later exec read those files back.
 * Stdin is a named pipe. The SDK's own stdin stream only reaches the
 * exec that owns it, so a second exec writes the pipe.
 */
export const BENTO_EXEC_PYTHON = `#!/usr/bin/env python3
import os
import sys
import time
import signal
import subprocess

def prepare(directory):
    os.makedirs(directory, exist_ok=True)
    fifo = os.path.join(directory, "stdin")
    if os.path.exists(fifo):
        os.remove(fifo)
    os.mkfifo(fifo, 0o600)
    for name in ("out", "err", "exit", "pid", "eof"):
        path = os.path.join(directory, name)
        if os.path.exists(path):
            os.remove(path)
    open(os.path.join(directory, "out"), "ab").close()
    open(os.path.join(directory, "err"), "ab").close()

def close_inherited_stdio():
    # The starter exec must be able to exit. Holding its stdout pipe
    # open would leave Modal treating that exec as still running.
    try:
        os.closerange(3, 256)
    except Exception:
        pass
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    if devnull > 2:
        os.close(devnull)

def pump(src, dest_path, kind):
    # One read, not a fill up to 64KiB. A buffered read waits for the
    # buffer or for the process to exit, so a command that prints and
    # then sleeps looks finished before a reattach can find it.
    with open(dest_path, "ab", buffering=0) as dest:
        while True:
            chunk = src.read(65536)
            if not chunk:
                break
            header = (kind + " " + str(len(chunk)) + "\\n").encode()
            dest.write(header)
            dest.write(chunk)
            dest.flush()

def run_daemon(directory, argv):
    fifo = os.path.join(directory, "stdin")
    read_fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
    write_fd = os.open(fifo, os.O_WRONLY)
    os.set_blocking(read_fd, True)
    os.dup2(read_fd, 0)
    os.close(read_fd)
    proc = subprocess.Popen(argv, stdin=0, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
    with open(os.path.join(directory, "pid"), "w") as handle:
        handle.write(str(proc.pid))
    import threading
    out_thread = threading.Thread(target=pump, args=(proc.stdout, os.path.join(directory, "out"), "o"), daemon=True)
    err_thread = threading.Thread(target=pump, args=(proc.stderr, os.path.join(directory, "err"), "e"), daemon=True)
    out_thread.start()
    err_thread.start()
    eof_path = os.path.join(directory, "eof")
    while proc.poll() is None:
        if write_fd is not None and os.path.exists(eof_path):
            os.close(write_fd)
            write_fd = None
        time.sleep(0.05)
    out_thread.join()
    err_thread.join()
    if write_fd is not None:
        os.close(write_fd)
    code = proc.returncode if proc.returncode is not None else 1
    # exit is last, so a follower that sees it has already been able
    # to read every frame both pumps wrote.
    with open(os.path.join(directory, "exit"), "w") as handle:
        handle.write(str(code))

def cmd_start(directory, argv):
    if not argv:
        sys.stderr.write("bento-exec start: missing command\\n")
        return 2
    prepare(directory)
    pid = os.fork()
    if pid > 0:
        os.waitpid(pid, 0)
        return 0
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    close_inherited_stdio()
    try:
        run_daemon(directory, argv)
    except Exception:
        try:
            with open(os.path.join(directory, "exit"), "w") as handle:
                handle.write("1")
        except Exception:
            pass
    os._exit(0)

def take_frames(data, pos):
    frames = []
    while True:
        nl = data.find(b"\\n", pos)
        if nl < 0:
            break
        header = data[pos:nl].decode("ascii", "replace")
        if len(header) < 2 or header[1] != " ":
            break
        kind = header[0]
        if kind not in ("o", "e"):
            break
        try:
            length = int(header[2:])
        except ValueError:
            break
        start = nl + 1
        if len(data) < start + length:
            break
        frames.append(data[pos:start + length])
        pos = start + length
    return frames, pos

def emit_file(path, pos):
    try:
        with open(path, "rb") as handle:
            handle.seek(pos)
            data = handle.read()
    except FileNotFoundError:
        return pos
    frames, consumed = take_frames(data, 0)
    for frame in frames:
        sys.stdout.buffer.write(frame)
    if frames:
        sys.stdout.buffer.flush()
    return pos + consumed

def cmd_follow(directory, offset):
    out_pos = offset
    err_pos = offset
    exit_path = os.path.join(directory, "exit")
    while True:
        out_pos = emit_file(os.path.join(directory, "out"), out_pos)
        err_pos = emit_file(os.path.join(directory, "err"), err_pos)
        if os.path.exists(exit_path):
            out_pos = emit_file(os.path.join(directory, "out"), out_pos)
            err_pos = emit_file(os.path.join(directory, "err"), err_pos)
            code = "1"
            try:
                code = open(exit_path).read().strip() or "1"
            except Exception:
                pass
            sys.stdout.buffer.write(("x " + code + "\\n").encode())
            sys.stdout.buffer.flush()
            return 0
        time.sleep(0.05)

def cmd_stdin(directory):
    fifo = os.path.join(directory, "stdin")
    with open(fifo, "wb", buffering=0) as dest:
        while True:
            chunk = sys.stdin.buffer.read(65536)
            if not chunk:
                break
            dest.write(chunk)
    return 0

def cmd_eof(directory):
    open(os.path.join(directory, "eof"), "w").close()
    return 0

def cmd_kill(directory):
    pid_path = os.path.join(directory, "pid")
    if not os.path.exists(pid_path):
        return 0
    try:
        pid = int(open(pid_path).read().strip())
    except Exception:
        return 0
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return 0
    except PermissionError:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return 0
    time.sleep(1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return 0

def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: bento-exec start|follow|stdin|eof|kill <dir>\\n")
        return 2
    command = argv[1]
    if command == "start":
        if len(argv) < 4 or argv[3] != "--":
            sys.stderr.write("usage: bento-exec start <dir> -- argv...\\n")
            return 2
        return cmd_start(argv[2], argv[4:])
    if len(argv) < 3:
        sys.stderr.write("bento-exec: missing directory\\n")
        return 2
    directory = argv[2]
    if command == "follow":
        offset = int(argv[3]) if len(argv) > 3 else 0
        return cmd_follow(directory, offset)
    if command == "stdin":
        return cmd_stdin(directory)
    if command == "eof":
        return cmd_eof(directory)
    if command == "kill":
        return cmd_kill(directory)
    sys.stderr.write("bento-exec: unknown command\\n")
    return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

/**
 * Pulls complete frames out of a follow stream.
 *
 * Frames are `o <len>\\n<bytes>`, `e <len>\\n<bytes>`, or `x <code>\\n`.
 * A chunk boundary can split a header or a payload, so bytes stay
 * buffered until a whole frame is present.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): ExecChunk[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: ExecChunk[] = [];
    while (true) {
      const next = takeFrame(this.buffer);
      if (!next) break;
      frames.push(next.frame);
      this.buffer = Buffer.from(next.rest);
    }
    return frames;
  }
}

function takeFrame(buf: Buffer): { frame: ExecChunk; rest: Buffer } | null {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return null;
  const header = buf.subarray(0, nl).toString("ascii");
  if (header.length < 2 || header[1] !== " ") return null;
  const kind = header[0];
  if (kind === "x") {
    const code = Number(header.slice(2).trim());
    return {
      frame: { kind: "exit", exitCode: Number.isFinite(code) ? code : -1 },
      rest: buf.subarray(nl + 1),
    };
  }
  if (kind !== "o" && kind !== "e") return null;
  const len = Number(header.slice(2).trim());
  if (!Number.isInteger(len) || len < 0) return null;
  const start = nl + 1;
  if (buf.length < start + len) return null;
  const data = buf.subarray(start, start + len).toString("utf8");
  const frame: ExecChunk = kind === "o" ? { kind: "stdout", data } : { kind: "stderr", data };
  return { frame, rest: buf.subarray(start + len) };
}

/** Directory name prefix for one command, so attach can find its newest run. */
export function execCommandKey(argv0: string): string {
  const base = argv0.split("/").pop() || "cmd";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return safe;
}

export function execDirectory(argv0: string, stamp = Date.now()): string {
  return `/var/bento/exec/${execCommandKey(argv0)}-${stamp}`;
}

/** The numeric stamp in `claude-171000`, or null when the name is something else. */
export function execStamp(name: string, argv0: string): number | null {
  const prefix = `${execCommandKey(argv0)}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

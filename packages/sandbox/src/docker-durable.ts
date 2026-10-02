/**
 * A Docker exec socket cannot be attached a second time. Keep the agent in
 * a detached exec and write its output into the sandbox before forwarding
 * it to the server. A replacement server reads the same record from its
 * last persisted cursor. The private Node bundled with the sandbox image
 * is used so the repository's own runtime and PATH are untouched.
 */
export const SANDBOX_NODE = "/opt/bento/node/bin/node";
export const DURABLE_DIR = "/tmp/bento-execs";

export const DURABLE_RUNNER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const spec = JSON.parse(process.argv[1]);
const dir = path.join('${DURABLE_DIR}', spec.key);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const log = fs.openSync(path.join(dir, 'events'), 'a');
const input = path.join(dir, 'input');
fs.closeSync(fs.openSync(input, 'a'));
fs.writeFileSync(path.join(dir, 'ready'), String(process.pid));
let seq = 0;
const write = (entry) => fs.writeSync(log, JSON.stringify({ ...entry, seq: ++seq }) + '\n');
let pending = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
const output = (kind, bytes, flush = false) => {
  let value = Buffer.concat([pending[kind], bytes]);
  let at;
  while ((at = value.indexOf(10)) !== -1) {
    write({ kind, data: value.subarray(0, at + 1).toString('base64') });
    value = value.subarray(at + 1);
  }
  if (flush && value.length) {
    write({ kind, data: value.toString('base64') });
    value = Buffer.alloc(0);
  }
  pending[kind] = value;
};
let child;
try {
  child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (error) {
  write({ kind: 'stderr', data: Buffer.from(String(error)).toString('base64') });
  write({ kind: 'exit', exitCode: -1 });
  process.exit(0);
}
child.stdout.on('data', (bytes) => output('stdout', bytes));
child.stderr.on('data', (bytes) => output('stderr', bytes));
let ended = false;
child.on('error', (error) => {
  output('stderr', Buffer.from(String(error)), true);
});
child.on('close', (code) => {
  if (ended) return;
  ended = true;
  clearInterval(poll);
  output('stdout', Buffer.alloc(0), true);
  output('stderr', Buffer.alloc(0), true);
  write({ kind: 'exit', exitCode: code ?? -1 });
  fs.closeSync(log);
});
let inputOffset = 0;
let inputBuffer = '';
const poll = setInterval(() => {
  if (ended) return;
  const size = fs.statSync(input).size;
  if (size <= inputOffset) return;
  const handle = fs.openSync(input, 'r');
  try {
    const bytes = Buffer.alloc(size - inputOffset);
    const count = fs.readSync(handle, bytes, 0, bytes.length, inputOffset);
    inputOffset += count;
    inputBuffer += bytes.subarray(0, count).toString('utf8');
    let at;
    while ((at = inputBuffer.indexOf('\n')) !== -1) {
      const line = inputBuffer.slice(0, at);
      inputBuffer = inputBuffer.slice(at + 1);
      const message = JSON.parse(line);
      if (message.kind === 'end') child.stdin.end();
      else if (message.kind === 'line') child.stdin.write(Buffer.from(message.data, 'base64'));
    }
  } finally {
    fs.closeSync(handle);
  }
}, 40);
if (!spec.stdin) child.stdin.end();
`;

export const DURABLE_READER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join('${DURABLE_DIR}', process.argv[1]);
const after = Number(process.argv[2]) || 0;
const file = path.join(dir, 'events');
let offset = 0;
let tail = '';
let missingSince = 0;
const poll = setInterval(() => {
  if (!fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  if (size > offset) {
    const handle = fs.openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(size - offset);
      const count = fs.readSync(handle, bytes, 0, bytes.length, offset);
      offset += count;
      tail += bytes.subarray(0, count).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
    let at;
    while ((at = tail.indexOf('\n')) !== -1) {
      const line = tail.slice(0, at);
      tail = tail.slice(at + 1);
      const record = JSON.parse(line);
      if (record.seq > after || record.kind === 'exit') process.stdout.write(line + '\n');
      if (record.kind === 'exit') {
        clearInterval(poll);
        return;
      }
    }
  }
  const pid = Number(fs.readFileSync(path.join(dir, 'ready'), 'utf8'));
  if (fs.existsSync('/proc/' + pid)) missingSince = 0;
  else if (!missingSince) missingSince = Date.now();
  else if (Date.now() - missingSince > 2000) {
    process.stdout.write(JSON.stringify({ kind: 'exit', exitCode: -1 }) + '\n');
    clearInterval(poll);
  }
}, 40);
`;

export function parseDurableRecord(line: string):
  | { kind: "stdout" | "stderr"; data: string; seq: number }
  | { kind: "exit"; exitCode: number; seq: number } {
  const record = JSON.parse(line) as { kind: string; data?: string; exitCode?: number; seq: number };
  if (record.kind === "exit") return { kind: "exit", exitCode: record.exitCode ?? -1, seq: record.seq };
  if (record.kind !== "stdout" && record.kind !== "stderr") throw new Error("invalid durable output record");
  return { kind: record.kind, data: Buffer.from(record.data ?? "", "base64").toString("utf8"), seq: record.seq };
}

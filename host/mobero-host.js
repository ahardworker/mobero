#!/usr/local/bin/node
/**
 * MOBero native messaging host.
 *
 * Chrome speaks to this over stdio: 4-byte little-endian length prefix, then
 * UTF-8 JSON. All it does is spawn/kill xmrig. Live stats come from xmrig's own
 * HTTP API, which the extension polls directly — that way the miner keeps
 * running even after the service worker goes to sleep and this host exits.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.mobero');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'xmrig.log');
const HOST_LOG = path.join(STATE_DIR, 'host.log');
const API_PORT = 45580;

/**
 * The browser launches this process and shows nothing when it dies — the
 * extension only ever learns "Native host has exited". So every launch, every
 * command and every crash goes here, or a failure has no evidence at all.
 */
function log(event, detail) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(
      HOST_LOG,
      `${new Date().toISOString()} ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}\n`,
    );
  } catch {
    /* logging must never be the thing that kills the host */
  }
}

process.on('uncaughtException', (err) => {
  log('crash', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  log('crash-async', { message: String(err) });
  process.exit(1);
});

log('launch', { argv: process.argv.slice(1), node: process.version, pid: process.pid });

const XMRIG_CANDIDATES = [
  '/opt/homebrew/bin/xmrig',
  '/usr/local/bin/xmrig',
  path.join(STATE_DIR, 'bin', 'xmrig'),
];

// ---------------------------------------------------------------- stdio frames

function send(msg) {
  const buf = Buffer.from(JSON.stringify(msg), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([len, buf]));
}

let inbox = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  while (inbox.length >= 4) {
    const len = inbox.readUInt32LE(0);
    if (inbox.length < 4 + len) break;
    const body = inbox.subarray(4, 4 + len).toString('utf8');
    inbox = inbox.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      send({ ok: false, error: `bad json: ${err.message}` });
      continue;
    }
    log('cmd', { cmd: msg.cmd });
    handle(msg);
  }
});
process.stdin.on('end', () => {
  log('stdin-end');
  process.exit(0);
});

// ----------------------------------------------------------------- state file

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function archOf(bin) {
  return /x86_64/.test(run('/usr/bin/file', ['-b', bin], 3000) || '') ? 'x86_64' : os.arch();
}

/**
 * Prefers a binary whose architecture matches the machine.
 *
 * Homebrew on an Apple Silicon machine is often the Intel install under
 * /usr/local, so `brew install xmrig` hands you an x86_64 miner that runs under
 * Rosetta at a fraction of native speed. Path order alone would pick that one
 * every time, even once a native build exists — so scan them all and take a
 * native match if there is one.
 */
function findXmrig() {
  const found = XMRIG_CANDIDATES.filter((c) => fs.existsSync(c));

  try {
    const w = execFileSync('/usr/bin/which', ['xmrig'], { encoding: 'utf8' }).trim();
    if (w && !found.includes(w)) found.push(w);
  } catch {
    /* not on PATH; the candidate list is all we have */
  }

  if (!found.length) return null;
  return found.find((bin) => archOf(bin) === os.arch()) || found[0];
}

// -------------------------------------------------------------------- commands

function handle(msg) {
  switch (msg.cmd) {
    case 'ping':
      return send({ ok: true, cmd: 'ping', host: '0.1.0', node: process.version });
    case 'probe':
      return probe();
    case 'start':
      return start(msg.config || {});
    case 'stop':
      return stop();
    case 'status':
      return status();
    default:
      return send({ ok: false, error: `unknown cmd: ${msg.cmd}` });
  }
}

function probe() {
  const bin = findXmrig();
  let version = null;
  let binArch = null;
  if (bin) {
    // Hard timeout: the first launch of a translated x86_64 binary can stall for
    // seconds, and this runs on the only thread we have.
    version = run(bin, ['--version'], 6000)?.split('\n')[0].trim() || null;
    binArch = /x86_64/.test(run('/usr/bin/file', ['-b', bin], 3000) || '') ? 'x86_64' : os.arch();
  }
  send({
    ok: true,
    cmd: 'probe',
    xmrig: bin,
    version,
    binArch,
    // Flag the slow path: RandomX under Rosetta is a fraction of native speed.
    translated: binArch === 'x86_64' && os.arch() === 'arm64',
    cores: os.cpus().length,
    platform: `${os.platform()}-${os.arch()}`,
  });
}

function run(bin, args, timeout) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// `--help` is stable across a miner's lifetime, so probe it once per binary and
// trust the answer. This is the difference between "0 H/s, no idea why" and a
// start request that fails with the actual reason.
const tlsCache = new Map();
function tlsSupported(bin) {
  if (!tlsCache.has(bin)) {
    const help = run(bin, ['--help'], 8000) || '';
    tlsCache.set(bin, /--tls/.test(help));
  }
  return tlsCache.get(bin);
}

// Stratum pools default to plain TCP; a bare host:443 or any explicit 443 is
// where --tls is actually required. Anything else either works either way or the
// user will get a pool error with the port they typed.
function poolNeedsTls(pool) {
  const m = /:(\d+)$/.exec(pool);
  return !m || m[1] === '443';
}

function start(config) {
  const existing = readState();
  if (existing && alive(existing.pid)) {
    return send({ ok: true, cmd: 'start', already: true, ...existing });
  }

  // Validate input before touching the filesystem, so a typo'd address reports
  // as a typo'd address rather than whatever else happens to be missing.
  const wallet = String(config.wallet || '').trim();
  if (!/^[48][0-9A-Za-z]{94,105}$/.test(wallet)) {
    return send({ ok: false, error: 'that does not look like a Monero address' });
  }

  const bin = findXmrig();
  if (!bin) {
    return send({ ok: false, error: 'xmrig not found — run install.sh or `brew install xmrig`' });
  }

  const cores = os.cpus().length;
  const threads = Math.max(1, Math.min(cores, Number(config.threads) || Math.floor(cores / 2)));
  const token = crypto.randomBytes(16).toString('hex');
  const pool = String(config.pool || 'pool.supportxmr.com:443');

  // Sent to the pool as the worker id. Never default to the hostname: on a
  // Tailscale/mDNS machine that is a fully-qualified name that identifies the
  // device to a third party, which is a strange thing to leak from a Monero tool.
  const worker = String(config.worker || 'mobero').replace(/\W+/g, '-').slice(0, 32);

  // Decide TLS before writing anything to disk: starting a miner that cannot
  // connect to its pool is not a start, it is a corpse with a pid.
  const needsTls = poolNeedsTls(pool);
  const tls = needsTls && tlsSupported(bin);
  if (needsTls && !tlsSupported(bin)) {
    return send({
      ok: false,
      error:
        `that pool needs TLS but this xmrig (${bin}) was built without it — ` +
        `rebuild with OpenSSL (host/build-xmrig-arm64.sh) or use a TLS-capable xmrig`,
    });
  }

  const args = [
    '--url', pool,
    '--user', wallet,
    '--pass', worker,
    '--coin', 'monero',
    '--keepalive',
    ...(tls ? ['--tls'] : []),
    '--threads', String(threads),
    '--cpu-priority', String(config.priority ?? 2),
    // xmrig defaults to 1% of mining time for its own authors. Nobody installs
    // a miner to fund a third party they were never asked about, so: 0.
    '--donate-level', String(config.donate ?? 0),
    '--http-host', '127.0.0.1',
    '--http-port', String(API_PORT),
    '--http-access-token', token,
    '--no-color',
  ];
  if (config.hugePages === false) args.push('--no-huge-pages');

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');

  // Detached + unref'd on purpose: xmrig outlives this host process, so the
  // browser closing the native port does not kill the miner.
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();

  // A miner that exits on startup (bad flag, missing library, gateway refusal
  // we would never see) used to survive just past this line and then leave the
  // extension polling a dead port forever. Give it a fixed moment, then ask
  // whether it is still there; if not, the log is the source of truth.
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 8; i++) sleep(250);
  if (!alive(child.pid)) {
    let snippet = '';
    try {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      snippet = lines.slice(-3).join(' | ').slice(0, 400);
    } catch {
      /* no log yet — the error is in `error` below */
    }
    return send({
      ok: false,
      error: snippet
        ? `xmrig exited at startup — ${snippet}`
        : 'xmrig exited at startup before it could log anything',
    });
  }

  const state = {
    pid: child.pid,
    token,
    port: API_PORT,
    pool,
    wallet,
    worker,
    threads,
    bin,
    tls,
    startedAt: Date.now(),
  };
  writeState(state);
  send({ ok: true, cmd: 'start', ...state });
}

function stop() {
  const state = readState();
  if (!state || !alive(state.pid)) {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      /* already gone */
    }
    return send({ ok: true, cmd: 'stop', wasRunning: false });
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    return send({ ok: false, error: `could not stop pid ${state.pid}: ${err.message}` });
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* fine */
  }
  send({ ok: true, cmd: 'stop', wasRunning: true, pid: state.pid });
}

function status() {
  const state = readState();
  const running = !!state && alive(state.pid);
  send({ ok: true, cmd: 'status', running, ...(running ? state : {}) });
}

send({ ok: true, cmd: 'hello', host: '0.1.0' });

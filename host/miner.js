/**
 * MOBero mining core — shared by the native-messaging host (mobero-host.js)
 * and the standalone CLI (mobero-cli.js).
 *
 * Nothing here knows about stdio frames or argv. Every function returns a
 * plain result object ({ ok, ... }); the caller decides how to deliver it —
 * the host sends it over the native port, the CLI prints it. That way the two
 * front ends can never drift apart on what "start" actually does.
 *
 * All of this is deliberately synchronous: the native host runs on a single
 * thread with no event loop to lean on, and the CLI is a one-shot process, so
 * a blocking spawn-then-check is simpler and correct for both.
 */

'use strict';

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

const IS_MAC = os.platform() === 'darwin';

// Where a native xmrig might live, per platform. ~/.mobero/bin (what our
// installer produces) is always in the list. On macOS the Homebrew prefixes
// matter because that is where `brew install xmrig` lands; on Linux the usual
// package / manual-install locations do.
const XMRIG_CANDIDATES = IS_MAC
  ? [
      path.join(STATE_DIR, 'bin', 'xmrig'),
      '/opt/homebrew/bin/xmrig',
      '/usr/local/bin/xmrig',
    ]
  : [
      path.join(STATE_DIR, 'bin', 'xmrig'),
      '/usr/local/bin/xmrig',
      '/usr/bin/xmrig',
      '/snap/bin/xmrig',
    ];

const WALLET_RE = /^[48][0-9A-Za-z]{94,105}$/;

// --------------------------------------------------------------------- logging

/**
 * The browser launches the host and shows nothing when it dies — the extension
 * only ever learns "Native host has exited". So every launch, command and
 * crash goes here, or a failure has no evidence at all. The CLI logs here too,
 * so ~/.mobero/host.log is a single timeline no matter which front end ran.
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

// ------------------------------------------------------------------ state file

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

// -------------------------------------------------------------- finding xmrig

function run(bin, args, timeout) {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The Mach-O / ELF architecture a binary was built for, normalised to Node's
 * os.arch() vocabulary ('arm64', 'x64', …) so it can be compared directly.
 *
 * This only matters on Apple Silicon, where `brew install xmrig` under an
 * Intel Homebrew hands you an x86_64 miner that runs under Rosetta at a
 * fraction of native RandomX speed. On Linux there is no such translation
 * layer to detect, so we don't bother — a mismatch there is not a silent
 * performance cliff.
 */
function archOf(bin) {
  if (!IS_MAC) return os.arch();
  const out = run('/usr/bin/file', ['-b', bin], 3000) || '';
  if (/x86_64/.test(out)) return 'x64';
  if (/arm64/.test(out)) return 'arm64';
  return os.arch();
}

/**
 * Prefer, on macOS, a binary whose architecture matches the machine: path
 * order alone would pick a Rosetta x86_64 build over a native one every time,
 * even once a native build exists. On Linux, first-found is fine.
 */
function findXmrig() {
  const found = XMRIG_CANDIDATES.filter((c) => fs.existsSync(c));

  // Also honour a PATH install the candidate list doesn't know about.
  const whichBin = IS_MAC ? '/usr/bin/which' : 'which';
  try {
    const w = execFileSync(whichBin, ['xmrig'], { encoding: 'utf8' }).trim();
    if (w && !found.includes(w)) found.push(w);
  } catch {
    /* not on PATH; the candidate list is all we have */
  }

  if (!found.length) return null;
  if (!IS_MAC) return found[0];
  return found.find((bin) => archOf(bin) === os.arch()) || found[0];
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
// where --tls is actually required. Anything else either works either way or
// the user gets a pool error with the port they typed.
function poolNeedsTls(pool) {
  const m = /:(\d+)$/.exec(pool);
  return !m || m[1] === '443';
}

// -------------------------------------------------------------------- probe

function probe() {
  const bin = findXmrig();
  let version = null;
  let binArch = null;
  if (bin) {
    // Hard timeout: the first launch of a translated x86_64 binary can stall
    // for seconds, and the host has only one thread.
    version = run(bin, ['--version'], 6000)?.split('\n')[0].trim() || null;
    binArch = archOf(bin);
  }
  return {
    ok: true,
    cmd: 'probe',
    xmrig: bin,
    version,
    binArch,
    // Flag the slow path: RandomX under Rosetta is a fraction of native speed.
    // Only possible on Apple Silicon; always false elsewhere.
    translated: IS_MAC && binArch === 'x64' && os.arch() === 'arm64',
    cores: os.cpus().length,
    platform: `${os.platform()}-${os.arch()}`,
    tls: bin ? tlsSupported(bin) : false,
  };
}

// -------------------------------------------------------------------- start

/**
 * Spawn xmrig detached and confirm it survived startup. Returns the session
 * object on success (pid, token, port, …) or { ok: false, error } describing
 * exactly what went wrong — a typo'd address reports as a typo, a missing
 * binary as a missing binary, a miner that dies at launch quotes its own log.
 */
function start(config = {}) {
  const existing = readState();
  if (existing && alive(existing.pid)) {
    return { ok: true, cmd: 'start', already: true, ...existing };
  }

  // Validate before touching the filesystem, so a bad address reports as a bad
  // address rather than whatever else happens to be missing downstream.
  const wallet = String(config.wallet || '').trim();
  if (!WALLET_RE.test(wallet)) {
    return { ok: false, error: 'that does not look like a Monero address' };
  }

  const bin = findXmrig();
  if (!bin) {
    return { ok: false, error: 'xmrig not found — run install.sh or install xmrig' };
  }

  const cores = os.cpus().length;
  const threads = Math.max(1, Math.min(cores, Number(config.threads) || Math.floor(cores / 2)));
  const token = crypto.randomBytes(16).toString('hex');
  const pool = String(config.pool || 'pool.supportxmr.com:443');

  // Sent to the pool as the worker id. Never default to the hostname: on a
  // Tailscale/mDNS machine that is a fully-qualified name that identifies the
  // device to a third party, which is a strange thing to leak from a Monero
  // tool.
  const worker = String(config.worker || 'mobero').replace(/\W+/g, '-').slice(0, 32);

  // Decide TLS before writing anything to disk: starting a miner that cannot
  // connect to its pool is not a start, it is a corpse with a pid.
  const needsTls = poolNeedsTls(pool);
  const tls = needsTls && tlsSupported(bin);
  if (needsTls && !tlsSupported(bin)) {
    return {
      ok: false,
      error:
        `that pool needs TLS but this xmrig (${bin}) was built without it — ` +
        `install a TLS-capable xmrig (build script on macOS, official static ` +
        `build on Linux) and try again`,
    };
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
  const logFd = fs.openSync(LOG_FILE, 'a');

  // Detached + unref'd on purpose: xmrig outlives this process, so the browser
  // closing the native port (or the CLI exiting) does not kill the miner.
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  // A miner that exits on startup (bad flag, missing library, gateway refusal
  // we would never see) used to survive just past this line and then leave the
  // caller polling a dead port forever. Give it a fixed moment, then ask
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
    return {
      ok: false,
      error: snippet
        ? `xmrig exited at startup — ${snippet}`
        : 'xmrig exited at startup before it could log anything',
    };
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
  return { ok: true, cmd: 'start', ...state };
}

// --------------------------------------------------------------------- stop

function stop() {
  const state = readState();
  if (!state || !alive(state.pid)) {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      /* already gone */
    }
    return { ok: true, cmd: 'stop', wasRunning: false };
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: `could not stop pid ${state.pid}: ${err.message}` };
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* fine */
  }
  return { ok: true, cmd: 'stop', wasRunning: true, pid: state.pid };
}

// -------------------------------------------------------------------- status

function status() {
  const state = readState();
  const running = !!state && alive(state.pid);
  return { ok: true, cmd: 'status', running, ...(running ? state : {}) };
}

module.exports = {
  API_PORT,
  STATE_DIR,
  STATE_FILE,
  LOG_FILE,
  HOST_LOG,
  WALLET_RE,
  IS_MAC,
  log,
  readState,
  findXmrig,
  probe,
  start,
  stop,
  status,
};

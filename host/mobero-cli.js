#!/usr/local/bin/node
/**
 * MOBero standalone CLI — the browser-free way to drive the miner.
 *
 *   mobero start [xmr-address] [--pool host:port] [--threads N] [--worker id]
 *                             [--donate N] [--no-huge-pages]
 *   mobero stop
 *   mobero status            (add --watch for a live hashrate readout)
 *   mobero wallet [xmr-address]   save / show the default address
 *   mobero probe
 *
 * It calls the exact same mining core (miner.js) the extension host does, so
 * anything you can do from the popup you can do from a terminal, on macOS or
 * Linux, with no extension and no native-messaging manifest involved. xmrig is
 * spawned detached, so it keeps mining after this command returns.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const miner = require('./miner');

// Remembered settings so the portable launcher (and repeat runs) need no
// re-typing. Just the wallet for now; it lives beside the state file.
const CONFIG_FILE = path.join(miner.STATE_DIR, 'config.json');
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  try {
    fs.mkdirSync(miner.STATE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {
    /* a config we can't save just means we ask again next time */
  }
}

const ORANGE = '\x1b[38;5;208m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `${code}${s}${RESET}` : s);

const say = (s) => console.log(`${paint(ORANGE, '»')} ${s}`);
const warn = (s) => console.log(`${paint(RED, '!')} ${s}`);
const die = (s) => {
  console.error(paint(RED, `✗ ${s}`));
  process.exit(1);
};

/** 1234 -> "1.23 kH/s". Mirrors extension/api.js so the numbers match. */
function fmtHashrate(hs) {
  if (!hs || hs < 0) return '0 H/s';
  if (hs < 1000) return `${hs.toFixed(0)} H/s`;
  return `${(hs / 1000).toFixed(2)} kH/s`;
}

/**
 * Tiny flag parser. Positional args land in `_`; `--flag value` and bare
 * `--flag` (boolean) both work, and `--no-x` sets `x` false — matching the
 * shape miner.start() already expects (hugePages, tls).
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.startsWith('no-')) {
        out[camel(key.slice(3))] = false;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out[camel(key)] = argv[++i];
      } else {
        out[camel(key)] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Pull live stats straight from xmrig's HTTP API, same as the extension. */
async function fetchSummary(session, timeoutMs = 2500) {
  if (!session?.port || !session?.token) return null;
  for (const path of ['/1/summary', '/2/summary']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${session.port}${path}`, {
        headers: { Authorization: `Bearer ${session.token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body && typeof body === 'object' && 'id' in body) return body;
    } catch {
      /* miner down or not up yet — try the next path */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function printProbe(p) {
  say(`platform: ${p.platform}  ·  ${p.cores} cores`);
  if (!p.xmrig) {
    warn('no xmrig found — run the installer, or install xmrig on your PATH');
    return;
  }
  say(`xmrig: ${p.xmrig}`);
  if (p.version) say(`version: ${p.version}`);
  say(`tls: ${p.tls ? paint(GREEN, 'yes') : paint(RED, 'no (most pools need it)')}`);
  if (p.translated) {
    warn('this xmrig is an Intel build under Rosetta — a native arm64 build mines several times faster');
  }
}

function printSession(s, live) {
  const uptime = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
  say(`mining  ·  pid ${s.pid}`);
  say(`pool: ${s.pool}${s.tls ? ' (tls)' : ''}`);
  say(`wallet: ${s.wallet.slice(0, 12)}…${s.wallet.slice(-6)}`);
  say(`threads: ${s.threads}  ·  worker: ${s.worker}  ·  up ${uptime}s`);
  if (live) {
    const hs = live.hashrate?.total?.[0] || 0;
    const accepted = live.results?.shares_good ?? 0;
    say(`hashrate: ${paint(GREEN, fmtHashrate(hs))}  ·  accepted shares: ${accepted}`);
  } else {
    say(`${paint(DIM, 'stats: xmrig HTTP API not answering yet (give it a few seconds)')}`);
  }
}

const HELP = `MOBero — standalone Monero miner (macOS + Linux)

  mobero start [xmr-address] [options]   start mining (address optional if saved)
  mobero stop                            stop mining
  mobero status [--watch]                show current session (and live hashrate)
  mobero wallet [xmr-address]            save, or show, the default address
  mobero probe                           check xmrig / TLS / architecture
  mobero help                            this text

start options:
  --pool host:port     pool to mine to        (default pool.supportxmr.com:443)
  --threads N          CPU threads             (default: half your cores)
  --worker id          worker label at the pool(default mobero)
  --donate N           % to the xmrig authors  (default 0 — every hash is yours)
  --priority N         xmrig --cpu-priority    (default 2)
  --no-huge-pages      disable huge pages

TLS is chosen automatically from the pool port (:443 uses it). The pool pays
your address directly — MOBero has no wallet and takes no fee.
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'start': {
      // Address from the command line wins; otherwise fall back to a saved one
      // so the launcher can start with no arguments.
      const saved = readConfig();
      const wallet = args._[0] || saved.wallet;
      if (!wallet) {
        die('no address — run "mobero start <xmr-address>" once, or "mobero wallet <xmr-address>" to save one');
      }
      if (args._[0] && miner.WALLET_RE.test(args._[0]) && args._[0] !== saved.wallet) {
        writeConfig({ ...saved, wallet: args._[0] }); // remember a freshly-typed good address
      }
      const config = {
        wallet,
        pool: args.pool,
        threads: args.threads ? Number(args.threads) : undefined,
        worker: args.worker,
        priority: args.priority ? Number(args.priority) : undefined,
        donate: args.donate ? Number(args.donate) : undefined,
      };
      if (args.hugePages === false) config.hugePages = false;
      say('starting xmrig…');
      const r = miner.start(config);
      if (!r.ok) die(r.error);
      if (r.already) {
        say(`already mining (pid ${r.pid}) — run "mobero stop" first to change settings`);
      } else {
        say(`started (pid ${r.pid}) → ${r.pool}${r.tls ? ' (tls)' : ''} with ${r.threads} threads`);
        say(`${paint(DIM, 'run "mobero status --watch" for a live hashrate, "mobero stop" to end')}`);
      }
      break;
    }

    case 'stop': {
      const r = miner.stop();
      if (!r.ok) die(r.error);
      say(r.wasRunning ? `stopped (was pid ${r.pid})` : 'nothing was running');
      break;
    }

    case 'status': {
      const s = miner.status();
      if (!s.running) {
        say('idle — nothing mining');
        break;
      }
      if (args.watch) {
        // Repaint in place until interrupted.
        process.on('SIGINT', () => {
          process.stdout.write('\n');
          process.exit(0);
        });
        for (;;) {
          const live = await fetchSummary(s);
          if (tty) process.stdout.write('\x1b[2J\x1b[H');
          printSession(s, live);
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
      printSession(s, await fetchSummary(s));
      break;
    }

    case 'wallet': {
      const cfg = readConfig();
      const addr = args._[0];
      if (!addr) {
        say(cfg.wallet ? `saved address: ${cfg.wallet}` : 'no address saved yet');
        break;
      }
      if (!miner.WALLET_RE.test(addr)) die('that does not look like a Monero address');
      writeConfig({ ...cfg, wallet: addr });
      say('saved — "mobero start" will use it');
      break;
    }

    case 'probe':
      printProbe(miner.probe());
      break;

    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      break;

    default:
      die(`unknown command: ${cmd}  (try: mobero help)`);
  }
}

main().catch((err) => die(err.message || String(err)));

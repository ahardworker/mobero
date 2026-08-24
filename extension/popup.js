import { fetchSummary, formatHashrate } from './api.js';
import {
  xmrPriceUSD,
  refreshNetworkHashrate,
  sessionXMR,
  formatXMR,
  formatUSD,
  formatPicon,
} from './earnings.js';

const el = (id) => document.getElementById(id);
const ui = {
  face: el('face'),
  tagline: el('tagline'),
  stats: el('stats'),
  setup: el('setup'),
  hashrate: el('hashrate'),
  meta: el('meta'),
  earnSession: el('earn-session'),
  earnSessionUsd: el('earn-session-usd'),
  earnSessionPicon: el('earn-session-picon'),
  earnTotal: el('earn-total'),
  earnTotalUsd: el('earn-total-usd'),
  earnTotalPicon: el('earn-total-picon'),
  wallet: el('wallet'),
  walletHint: el('wallet-hint'),
  threads: el('threads'),
  threadsValue: el('threads-value'),
  threadsHint: el('threads-hint'),
  pool: el('pool'),
  notice: el('notice'),
  error: el('error'),
  toggle: el('toggle'),
  onboard: el('onboard'),
  onboardTitle: el('onboard-title'),
  onboardLead: el('onboard-lead'),
  onboardSteps: el('onboard-steps'),
  onboardCmdRow: el('onboard-cmd-row'),
  onboardCmd: el('onboard-cmd'),
  onboardCopy: el('onboard-copy'),
  onboardNote: el('onboard-note'),
  onboardRaw: el('onboard-raw'),
  payouts: el('payouts'),
  payoutsTitle: el('payouts-title'),
  payoutsLead: el('payouts-lead'),
  payoutsOpen: el('payouts-open'),
  payoutsCopy: el('payouts-copy'),
  payoutsNote: el('payouts-note'),
};

const INSTALL_CMD = 'curl -fsSL https://mobero.org/install.sh | sh';

/**
 * What to show when MOBero can't mine yet. Each case is a dead end the user
 * cannot get out of on their own — so each one names the fix, hands over the
 * exact command, and leaves a button that re-checks.
 */
const ONBOARDING = {
  missing: {
    title: 'One step left',
    lead: "MOBero drives a miner on your Mac, so it needs a small helper installed. It doesn't exist yet.",
    steps: ['Open Terminal', 'Paste this and press return', 'Come back here and press Check again'],
    cmd: INSTALL_CMD,
    note: 'Installs xmrig and registers the helper. It never asks for your address — you paste that here.',
  },
  forbidden: {
    title: 'Wrong extension',
    lead: 'The helper is installed, but it was registered for a different extension ID than this one.',
    steps: [
      'Check the ID on chrome://extensions reads bgnkdiknnhpffnhhehnbodmnjcgbjoap',
      'If it does not, remove this copy and load the extension folder the installer unpacked',
      'Otherwise re-run the installer',
    ],
    cmd: INSTALL_CMD,
    note: 'The ID is pinned by the manifest key, so a fresh install of the published folder always matches.',
  },
  broken: {
    title: 'Helper is not starting',
    lead: 'The helper is registered, but it exits the moment the browser launches it.',
    steps: [
      'Check Node is installed: node --version',
      'Re-run the installer — it re-pins the helper to your current Node',
      'Then press Check again',
    ],
    cmd: INSTALL_CMD,
    note: 'Every launch and crash is logged to ~/.mobero/host.log — that file says why.',
  },
  noXmrig: {
    title: 'Miner is missing',
    lead: 'The helper is working, but xmrig — the miner it drives — is not installed.',
    steps: ['Open Terminal', 'Paste this and press return', 'Come back here and press Check again'],
    cmd: 'brew install xmrig',
    note: 'On Apple Silicon, an arm64 build mines several times faster than the Intel one under Rosetta.',
  },
  noTls: {
    title: 'This xmrig has no TLS',
    lead: 'The pool needs an encrypted connection, but the xmrig you ran was built without TLS, so it refused to start. Build one that has it and it will be used automatically.',
    steps: [
      'Make sure OpenSSL is present (brew install openssl if not)',
      'From the MOBero folder run the build script',
      'Press Check again — the new binary lives where the helper already looks',
    ],
    cmd: 'bash host/build-xmrig-arm64.sh',
    note: 'Produces a native arm64 miner with TLS, faster than the Intel build under Rosetta.',
  },
};

const WALLET_RE = /^[48][0-9A-Za-z]{94,105}$/;
let session = null;
let poller = null;
let onboarding = false;

// ------------------------------------------------------------------ payouts

/**
 * Which pool, really. A local endpoint (127.0.0.1, localhost, or a LAN
 * address) means the user runs their own node — there is no pool ledger to
 * check, and blocks pay the wallet directly the moment they are found.
 * Everything else is treated as a third-party pool; the one we install with
 * is supportxmr.com, and its payout page is the one that actually knows how
 * much has been credited.
 */
function payoutsMode() {
  const pool = (session?.pool || ui.pool.value.trim() || 'pool.supportxmr.com:443').toLowerCase();
  const host = pool.split(':')[0];
  if (host === '127.0.0.1' || host === 'localhost' || /^(10\.|192\.168\.|172\.(1[6-9]|[2-9]\d|1\d\d)\.)/.test(host)) {
    return 'solo';
  }
  return 'pool';
}

function payoutLink() {
  const wallet = ui.wallet.value.trim();
  const enc = encodeURIComponent(wallet);
  if (payoutsMode() === 'solo') {
    // Blocks found on a local node pay the wallet directly — the honest
    // "did my block actually land" check is a block-explorer search.
    return wallet ? `https://xmrchain.net/?search=${enc}` : 'https://xmrchain.net/';
  }
  return wallet ? `https://supportxmr.com/?addr=${enc}` : 'https://supportxmr.com/';
}

function renderPayouts() {
  const wallet = ui.wallet.value.trim();
  const hasWallet = WALLET_RE.test(wallet);
  const pool = (session?.pool || ui.pool.value.trim() || 'pool.supportxmr.com:443');
  const host = pool.split(':')[0];

  if (payoutsMode() === 'solo') {
    ui.payoutsTitle.textContent = 'Payouts — solo';
    ui.payoutsLead.textContent =
      'No pool in the middle. Every block you find pays your wallet in full, the moment it is accepted.';
    ui.payoutsOpen.textContent = wallet ? 'Check blocks found →' : 'Open block explorer →';
    ui.payoutsNote.textContent = `${host}:solo · instant · no threshold`;
  } else {
    ui.payoutsTitle.textContent = 'Payouts';
    ui.payoutsLead.textContent =
      'Earnings accumulate at the pool until they cross the payout threshold, then they sweep to your address.';
    ui.payoutsOpen.textContent = 'Check pool balance →';
    ui.payoutsNote.textContent = `${host} · 0.01 XMR minimum`;
  }

  ui.payoutsOpen.disabled = false;
  ui.payoutsCopy.disabled = !hasWallet;
  ui.payoutsCopy.textContent = hasWallet ? 'Copy address' : '—';
  ui.payoutsCopy.title = hasWallet ? 'Copies your wallet to the clipboard. Most pool pages just want a paste.' : 'Paste a wallet address first';
}

// --------------------------------------------------------------------- boot

init();

async function init() {
  hideError();
  hideNotice();
  const saved = await chrome.storage.local.get(['wallet', 'threads', 'pool', 'session']);
  if (saved.wallet) ui.wallet.value = saved.wallet;
  if (saved.pool) ui.pool.value = saved.pool;
  renderPayouts();

  const probe = await send({ type: 'probe' });
  if (!probe.ok) {
    return enterOnboardingState(probe.hostState || 'broken', probe.error);
  }
  if (!probe.xmrig) {
    return enterOnboardingState('noXmrig');
  }

  if (probe.translated) {
    showNotice(
      'Heads up: your xmrig is an Intel build running under Rosetta. RandomX ' +
        'takes a big hit — an arm64 build mines several times faster.',
    );
  }

  const cores = probe.cores || 4;
  ui.threads.max = String(cores);
  ui.threads.value = String(saved.threads || Math.max(1, Math.floor(cores / 2)));
  syncThreadsLabel(cores);

  const status = await send({ type: 'status' });
  if (status.ok && status.running) {
    session = status;
    enterMiningState();
  } else {
    enterIdleState();
  }
}

// ------------------------------------------------------------------ wiring

ui.threads.addEventListener('input', () => syncThreadsLabel(Number(ui.threads.max)));

ui.wallet.addEventListener('input', () => {
  const v = ui.wallet.value.trim();
  ui.wallet.classList.toggle('bad', v.length > 0 && !WALLET_RE.test(v));
  hideError();
  renderPayouts();
});

ui.payoutsCopy.addEventListener('click', async () => {
  const wallet = ui.wallet.value.trim();
  if (!WALLET_RE.test(wallet)) return;
  try {
    await navigator.clipboard.writeText(wallet);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(ui.wallet);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  ui.payoutsCopy.textContent = 'Copied';
  setTimeout(() => {
    if (WALLET_RE.test(ui.wallet.value.trim())) ui.payoutsCopy.textContent = 'Copy address';
  }, 1800);
});

ui.payoutsOpen.addEventListener('click', async () => {
  const wallet = ui.wallet.value.trim();
  // Pre-copy the address when we can: the pool page has to be pasted into by
  // hand, so one less field to hunt for makes the "where is my dust" check
  // actually doable in under ten seconds.
  if (WALLET_RE.test(wallet)) {
    try {
      await navigator.clipboard.writeText(wallet);
    } catch {
      /* no clipboard access in a popup without focus — the paste still works */
    }
  }
  const url = payoutLink();
  const win = window.open(url, '_blank');
  if (!win) {
    // Popup windows can block popups; hand the URL to the user instead.
    showError(`Open this to check your balance: ${url}`);
  }
});

ui.toggle.addEventListener('click', () => {
  if (onboarding) return recheck();
  return session ? stop() : start();
});

ui.onboardCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ui.onboardCmd.textContent.trim());
    ui.onboardCopy.textContent = 'Copied';
    ui.onboardCopy.classList.add('done');
  } catch {
    // No clipboard permission — select it so the keyboard still works.
    const range = document.createRange();
    range.selectNodeContents(ui.onboardCmd);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    ui.onboardCopy.textContent = '\u2318C';
  }
  setTimeout(() => {
    ui.onboardCopy.textContent = 'Copy';
    ui.onboardCopy.classList.remove('done');
  }, 2000);
});

/** Re-run the whole boot, so a fix made in Terminal is picked up in place. */
async function recheck() {
  ui.toggle.disabled = true;
  ui.toggle.textContent = 'Checking…';
  await init();
  if (onboarding) {
    ui.toggle.textContent = 'Check again';
    ui.toggle.disabled = false;
  }
}

// ----------------------------------------------------------------- actions

async function start() {
  const wallet = ui.wallet.value.trim();
  if (!WALLET_RE.test(wallet)) {
    ui.wallet.classList.add('bad');
    showError('That address does not look like a Monero address.');
    return;
  }

  const config = {
    wallet,
    threads: Number(ui.threads.value),
    pool: ui.pool.value.trim() || 'pool.supportxmr.com:443',
  };

  hideError();
  ui.toggle.disabled = true;
  ui.toggle.textContent = 'Warming up…';

  const result = await send({ type: 'start', config });
  ui.toggle.disabled = false;

  if (!result.ok) {
    // A TLS-less xmrig is a specific, fixable dead end — give it the matching
    // instruction card rather than a red error line.
    if (/no TLS|built without it|lacks TLS/i.test(result.error || '')) {
      return enterOnboardingState('noTls', result.error);
    }
    showError(result.error);
    enterIdleState();
    return;
  }

  await chrome.storage.local.set({ wallet, threads: config.threads, pool: config.pool });
  session = result;
  renderPayouts();
  enterMiningState();
}

async function stop() {
  ui.toggle.disabled = true;
  ui.toggle.textContent = 'Stopping…';
  await send({ type: 'stop' });
  session = null;
  ui.toggle.disabled = false;
  enterIdleState();
}

// ------------------------------------------------------------------- states

function enterMiningState() {
  ui.stats.hidden = false;
  ui.setup.hidden = true;
  ui.face.classList.add('mining');
  ui.tagline.textContent = 'digging…';
  ui.toggle.textContent = 'Stop mining';
  ui.toggle.classList.add('running');
  startPolling();
}

/** Setup form out, instructions in, and the main button becomes the re-check. */
function enterOnboardingState(kind, rawError) {
  stopPolling();
  const copy = ONBOARDING[kind] || ONBOARDING.broken;

  ui.onboardTitle.textContent = copy.title;
  ui.onboardLead.textContent = copy.lead;
  ui.onboardSteps.replaceChildren(
    ...copy.steps.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
  ui.onboardCmd.textContent = copy.cmd;
  ui.onboardNote.textContent = copy.note;

  // Only worth showing when there is a browser message behind it; a missing
  // xmrig is self-explanatory and the raw string would just add noise.
  ui.onboardRaw.textContent = rawError || '';
  ui.onboardRaw.parentElement.hidden = !rawError;

  ui.onboard.hidden = false;
  ui.setup.hidden = true;
  ui.stats.hidden = true;
  ui.face.classList.remove('mining');
  ui.tagline.textContent = 'not ready yet';
  ui.toggle.textContent = 'Check again';
  ui.toggle.classList.remove('running');
  ui.toggle.disabled = false;
  onboarding = true;
}

function enterIdleState() {
  onboarding = false;
  ui.onboard.hidden = true;
  stopPolling();
  ui.stats.hidden = true;
  ui.setup.hidden = false;
  ui.face.classList.remove('mining');
  ui.tagline.textContent = 'Ride with the Mob — join the mining pool to strengthen the network';
  ui.toggle.textContent = 'Start mining';
  ui.toggle.classList.remove('running');
}

// ------------------------------------------------------------------ polling

function startPolling() {
  stopPolling();
  tick();
  poller = setInterval(tick, 1000);
}

function stopPolling() {
  if (poller) clearInterval(poller);
  poller = null;
}

async function tick() {
  const summary = await fetchSummary(session);
  if (!summary) {
    // xmrig needs a few seconds to bind its API; only give up if it truly died.
    const status = await send({ type: 'status' });
    if (!status.running) {
      session = null;
      enterIdleState();
      showError('Miner stopped. Check ~/.mobero/xmrig.log for why.');
    }
    return;
  }
  const rates = summary.hashrate?.total || [];
  ui.hashrate.textContent = formatHashrate(rates[0] || 0);

  const shares = summary.results?.shares_good ?? 0;
  ui.meta.textContent = `shares ${shares} · ${session.threads ?? '—'} threads · ${formatUptime(
    summary.uptime || 0,
  )}`;

  // Session = accepted shares since this miner process started (xmrig's own
  // counters). Total = this plus every earlier run, kept in chrome.storage so
  // a restart never wipes your real earnings.
  // Both are cached inside earnings.js (price 5 min, difficulty 1 h) and both
  // fail soft, so this is cheap to call on every poll.
  const [price] = await Promise.all([xmrPriceUSD(), refreshNetworkHashrate()]);

  const sessionEarnings = sessionXMR(summary);
  const st = (await chrome.storage.local.get('earnState')).earnState ||
    { finalized: 0, highWater: 0 };

  // xmrig's share counter only grows within a run and resets near zero when it
  // restarts. A live value meaningfully below our high-water mark therefore
  // signals a new run: bank the old run's work into `finalized`.
  if (st.highWater > 0 && sessionEarnings < st.highWater * 0.5) {
    st.finalized += st.highWater;
    st.highWater = sessionEarnings;
  } else {
    st.highWater = Math.max(st.highWater, sessionEarnings);
  }
  await chrome.storage.local.set({ earnState: st });

  const totalEarnings = st.finalized + st.highWater;
  ui.earnSession.textContent = formatXMR(sessionEarnings);
  ui.earnSessionUsd.textContent = formatUSD(sessionEarnings * price);
  ui.earnSessionPicon.textContent = formatPicon(sessionEarnings) + ' picon';
  ui.earnTotal.textContent = formatXMR(totalEarnings);
  ui.earnTotalUsd.textContent = formatUSD(totalEarnings * price);
  ui.earnTotalPicon.textContent = formatPicon(totalEarnings) + ' picon';
}

// ------------------------------------------------------------------- helpers

function send(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({
    ok: false,
    error: String(err?.message || err),
  }));
}

function syncThreadsLabel(cores) {
  const n = Number(ui.threads.value);
  ui.threadsValue.textContent = `${n} / ${cores}`;
  ui.threadsHint.textContent =
    n >= cores
      ? 'All cores — expect fans, and a slow laptop.'
      : n > cores / 2
        ? 'Toasty. Fine when plugged in.'
        : 'Half your cores keeps the laptop usable.';
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function showNotice(text) {
  ui.notice.textContent = text;
  ui.notice.hidden = false;
}

function showError(text) {
  ui.error.textContent = text;
  ui.error.hidden = false;
}

function hideError() {
  ui.error.hidden = true;
}

function hideNotice() {
  ui.notice.hidden = true;
}

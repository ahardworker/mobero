/**
 * Estimated earnings.
 *
 * We can't ask the pool how much you've earned — pool.supportxmr.com's API
 * serves a self-signed certificate, so the browser will refuse to fetch it.
 * Instead we estimate it the way the network actually pays out: an accepted
 * share proves `diff` units of work, and Monero mints 0.6 XMR per block on a
 * 120-second target — 720 blocks a day, 432 XMR/day, split across everyone
 * hashing.
 *
 *     XMR per share = diff × 432 ÷ (network H/s × 86,400 s/day)
 *
 * Network hashrate is fetched live rather than pinned, because it is the term
 * that moves: it has roughly doubled every couple of years, and every increase
 * divides the same 432 XMR across more work. A hardcoded figure would quietly
 * overpay the estimate forever.
 *
 * The $ figure is live from CoinGecko (free, no key). These are *estimates*,
 * not pool-reported balances — the honest number to show, since payout is
 * linear in your share of network work (minus the pool fee).
 */

/** Network-wide emission: 0.6 XMR/block × 720 blocks/day (120 s target). */
export const DAILY_XMR = 432;
/** A solo block pays the whole thing: 0.6 tail emission + transaction fees. */
export const SOLO_BLOCK_XMR = 0.62;
/** Used until the live fetch lands, and if it never does. ~5.9 GH/s, Aug 2026. */
export const NETWORK_HASHRATE_FALLBACK = 5.9e9;

let networkHashrate = NETWORK_HASHRATE_FALLBACK;
let networkAt = 0;

/** XMR proven per hash running for one second, at the last known difficulty. */
export function xmrPerHashSec() {
  return DAILY_XMR / (86400 * networkHashrate);
}

/** The hashrate the estimates are currently divided by. */
export function currentNetworkHashrate() {
  return networkHashrate;
}

/**
 * Refresh the network hashrate, hourly at most. Failure is not an error — the
 * previous value (or the fallback) keeps the numbers flowing offline.
 */
export async function refreshNetworkHashrate() {
  if (networkAt && Date.now() - networkAt < 60 * 60 * 1000) return networkHashrate;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch('https://xmrchain.net/api/networkinfo', { signal: ctrl.signal });
    if (res.ok) {
      const hr = Number((await res.json())?.data?.hash_rate);
      if (hr > 0) {
        networkHashrate = hr;
        networkAt = Date.now();
      }
    }
  } catch {
    /* offline or blocked — keep the last good value */
  } finally {
    clearTimeout(timer);
  }
  return networkHashrate;
}

let cached = null;

/** Live XMR→USD spot price, cached for 5 minutes, sensible fallback if offline. */
export async function xmrPriceUSD() {
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.price;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd',
      { signal: ctrl.signal },
    );
    if (res.ok) {
      const body = await res.json();
      const p = Number(body?.monero?.usd);
      if (p > 0) {
        cached = { at: Date.now(), price: p };
        return p;
      }
    }
  } catch {
    /* offline or blocked — fall through */
  } finally {
    clearTimeout(timer);
  }
  return cached?.price || 300;
}

/**
 * XMR mined this run — accepted shares × the proof each one carries, plus any
 * full blocks this own-node run found. One solo block pays the whole reward
 * (emission + fees); a share of a pool pays dust. Both are real earnings.
 */
export function sessionXMR(summary) {
  const shares = summary?.results?.shares_good || 0;
  const diff = summary?.results?.diff_current || 0;
  const blocks = summary?.results?.blocks_found || 0;
  let xmr = 0;
  if (shares && diff) xmr += shares * diff * xmrPerHashSec();
  if (blocks) xmr += blocks * SOLO_BLOCK_XMR;
  return xmr;
}

/** Sustained XMR/day at a hashrate — the anchor for the "per year" note. */
export function dailyXMRAt(hps) {
  return (hps || 0) * xmrPerHashSec() * 86400;
}

/** Three significant digits, trimmed: 2.12e-12 → "0.00000000000212"; 0.42 → "0.42". */
function toFixedSig(x, sig = 3) {
  if (!x || x <= 0) return '0';
  const dec = Math.max(0, sig - 1 - Math.floor(Math.log10(x)));
  return x.toFixed(Math.min(dec, 30)).replace(/\.?0+$/, '') || '0';
}

/**
 * Hobby hashrates mine at 10⁻⁹ XMR, so plain toFixed(2) would read "0.00" —
 * that's why the column existed in the design with a zero in it. Small values
 * earn significant digits; normal values stay tidy.
 */
export function formatXMR(x) {
  if (!x || x <= 0) return '0.00';
  if (x >= 100) return Math.round(x).toLocaleString('en-US');
  return toFixedSig(x);
}

export function formatUSD(usd) {
  if (!usd || usd <= 0) return '$0.00';
  if (usd >= 100) return '$' + Math.round(usd).toLocaleString('en-US');
  if (usd >= 1) return '$' + (usd < 10 ? usd.toFixed(2) : usd.toFixed(1));
  return '$' + toFixedSig(usd);
}

/**
 * Picon — 1 XMR = 1e12 picon, Monero's finest unit. Where XMR reads "0.00"
 * and dollars read "$0.00004", picon is a healthy round integer: one accepted
 * share at difficulty 100 000 ≈ 85 000 picon. The number a hobby miner
 * actually earns, in a unit that doesn't round it away.
 */
export function formatPicon(xmr) {
  if (!xmr || xmr <= 0) return '0';
  if (xmr >= 1) return (xmr * 1e12).toLocaleString('en-US');
  return Math.round(xmr * 1e12).toString();
}

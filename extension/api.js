/** Thin client for xmrig's built-in HTTP API. */

export async function fetchSummary(session, timeoutMs = 2500) {
  if (!session?.port || !session?.token) return null;
  // xmrig 6.26.0 serves its HTTP API under /1/; some builds advertise /2/.
  // Probe in that order so a version change never blanks the dashboard again.
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
      // miner is down, or not up yet — try the next path before giving up
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** 1234 -> "1.2 kH/s", or "1.2k" in compact mode for the badge. */
export function formatHashrate(hs, compact = false) {
  if (!hs || hs < 0) return compact ? '0' : '0 H/s';
  if (hs < 1000) return compact ? String(Math.round(hs)) : `${hs.toFixed(0)} H/s`;
  const k = hs / 1000;
  return compact ? `${k.toFixed(1)}k` : `${k.toFixed(2)} kH/s`;
}

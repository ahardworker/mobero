/**
 * MOBero service worker.
 *
 * Owns the native-messaging conversation (start/stop/probe) and keeps the
 * toolbar badge roughly in sync. Live stats are read straight from xmrig's
 * HTTP API by whoever needs them — see api.js.
 */

import { fetchSummary, formatHashrate } from './api.js';

const HOST = 'com.mobero.host';

/**
 * Chrome reports every native-messaging failure as a sentence, and the three
 * that matter need three different things from the user. Sorting them here
 * means the popup can walk someone through the fix instead of printing the
 * sentence and giving up.
 *
 *   missing   — the host manifest was never written. Run the installer.
 *   forbidden — manifest exists but lists a different extension ID.
 *   broken    — it launched and died. Something is wrong with node or the file.
 */
function classify(message = '') {
  if (/not found|not registered|no such native/i.test(message)) return 'missing';
  if (/forbidden|not allowed|access to the specified/i.test(message)) return 'forbidden';
  return 'broken';
}

/** One request/response round trip. The port is torn down right after; xmrig
 *  is detached, so nothing dies with it. */
function ask(message, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (err) {
      const error = String(err?.message || err);
      resolve({ ok: false, error, hostState: classify(error) });
      return;
    }

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => done({ ok: false, error: 'the helper did not answer in time', hostState: 'broken' }),
      timeoutMs,
    );

    port.onMessage.addListener((msg) => {
      // The host greets on connect; ignore that and wait for our reply.
      if (msg && msg.cmd === 'hello') {
        port.postMessage(message);
        return;
      }
      done(msg);
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'native host disconnected';
      done({ ok: false, error: err, hostState: classify(err) });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'probe':
        sendResponse(await ask({ cmd: 'probe' }));
        break;
      case 'status':
        sendResponse(await ask({ cmd: 'status' }));
        break;
      case 'start': {
        const result = await ask({ cmd: 'start', config: msg.config });
        if (result.ok) {
          await chrome.storage.local.set({ session: result });
          setBadge('•', '#f26022');
          chrome.alarms.create('tick', { periodInMinutes: 1 });
        }
        sendResponse(result);
        break;
      }
      case 'stop': {
        const result = await ask({ cmd: 'stop' });
        await chrome.storage.local.remove('session');
        chrome.alarms.clear('tick');
        setBadge('', '#f26022');
        sendResponse(result);
        break;
      }
      default:
        sendResponse({ ok: false, error: `unknown message: ${msg?.type}` });
    }
  })();
  return true; // async response
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'tick') return;
  const { session } = await chrome.storage.local.get('session');
  if (!session) {
    chrome.alarms.clear('tick');
    return;
  }
  const summary = await fetchSummary(session);
  if (!summary) {
    setBadge('', '#f26022');
    chrome.alarms.clear('tick');
    await chrome.storage.local.remove('session');
    return;
  }
  const hs = summary.hashrate?.total?.[0] || 0;
  setBadge(formatHashrate(hs, true), '#f26022');
});

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

# MOBero

One-click Monero mining, wearing a fedora. **macOS and Linux.**

You paste your own XMR address. The pool pays that address directly. MOBero has
no wallet, no fee, and no server — there is nowhere for your money to go except
to you.

There are two ways to run it, and they share the same mining core
([`host/miner.js`](host/miner.js)): a **standalone CLI** (no browser needed) and
an optional **browser extension** for Chrome, Chromium, Brave, or Edge.

## Install

From a clone:

```bash
./install.sh
```

That installs the `mobero` CLI to `~/.local/bin`, registers the extension's
native host with whichever Chromium browsers you have, and finds or produces a
TLS-capable `xmrig` native to your machine:

- an existing good binary wins;
- on Apple Silicon it builds a native arm64 one
  ([`host/build-xmrig-arm64.sh`](host/build-xmrig-arm64.sh));
- on Linux x86_64 it downloads xmrig's official static build (which ships with
  TLS);
- otherwise it falls back to `brew` (macOS) or tells you the one package to
  install (Linux).

It does not start mining and never asks for a wallet.

## Standalone CLI

The browser-free way. After `./install.sh` (and, if it warned you, adding
`~/.local/bin` to your `PATH`):

```bash
mobero start <your-monero-address>   # begins mining, detached
mobero status --watch                # live hashrate + accepted shares
mobero stop
mobero probe                         # checks xmrig / TLS / architecture
```

`start` takes `--pool host:port`, `--threads N`, `--worker id`, `--donate N`,
`--priority N`, and `--no-huge-pages`. Run `mobero help` for the full list. The
miner is spawned detached, so it keeps running after the command returns —
`mobero stop` (or the command in [Turning it off](#turning-it-off)) ends it.

## Browser extension (optional)

Load it by hand:

1. open `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
2. turn on **Developer mode**
3. **Load unpacked** → this repo's `extension/`
4. the ID should read `bgnkdiknnhpffnhhehnbodmnjcgbjoap`

Click the mobster, paste your address, hit Start.

**Does Brave allow this?** Yes. The stores (Chrome Web Store, Firefox AMO) ban
*publishing* mining extensions, which is why this one is load-unpacked — but no
Chromium browser blocks *running* one. And MOBero never mines inside the
browser anyway: the extension only starts, stops, and reads a native `xmrig`
process over native messaging. If you'd rather skip the extension entirely, use
the CLI above.

## No exceptions

xmrig, the miner underneath, ships with a 1% developer donation turned on by
default. MOBero sets **`--donate-level 0`** — you can see the flag in
[`host/mobero-host.js`](host/mobero-host.js). Supporting xmrig is a fine thing
to do, but it isn't ours to decide on your hardware. Every hash is yours.

If you do want to chip in, pass `donate` in the start message (or edit that one
line) and it goes to the xmrig authors — never to MOBero, which has no address
to send it to.

## How it fits together

```
popup  ──chrome.runtime──>  service worker  ──native messaging──>  mobero-host.js ┐
  │                                                                                │
mobero (CLI)  ─────────────────────────────────────────────────────────────────> miner.js
  │                                                                                │
  │                                                                          spawns detached
  │                                                                                ▼
  └────────────── polls http://127.0.0.1:45580 ────────────────────────────────  xmrig
```

Both front ends call the same core, [`host/miner.js`](host/miner.js), which
spawns xmrig **detached** — so mining survives the popup closing, the service
worker being evicted, or the CLI process exiting. Live stats come from xmrig's
own HTTP API, which the extension and `mobero status` poll directly; the core is
only ever asked to start, stop, or report status.

State lives in `~/.mobero/state.json` (pid + API token). Logs are in
`~/.mobero/xmrig.log`.

## What you'll actually earn

Monero mints 0.6 XMR per block on a 120-second target — 432 XMR a day, split
across everyone hashing. Your cut is your share of the network and nothing
else. At roughly 5.9 GH/s network-wide, that's about `7.3 × 10⁻⁸` XMR per H/s
per day:

| Machine | Hashrate | XMR/day | XMR/year |
|---|---|---|---|
| M-series base | ~2.8 kH/s | 0.00020 | 0.075 |
| M-series Max | ~6 kH/s | 0.00044 | 0.16 |
| Ryzen 7 7700X | ~10.5 kH/s | 0.00077 | 0.28 |
| Threadripper 9965WX | ~30 kH/s | 0.0022 | 0.80 |

The extension shows this live, and fetches the network hashrate hourly rather
than pinning it, because difficulty only goes up. Numbers that flatter you are
worse than no numbers.

## Getting the most out of it

- **Native architecture matters most.** On Apple Silicon, RandomX under Rosetta
  runs at a fraction of native speed, so the installer builds a native arm64
  binary rather than let that happen quietly, and both front ends warn you if
  they spot a translated one. On Linux x86_64 the installer pulls xmrig's
  official native static build, so there's no translation penalty to fight.
- **Threads = performance cores**, not total cores. E-cores add heat more than
  hashes.
- **Leave ~2.3 GB of RAM free.** Below that, RandomX drops to light mode —
  roughly 10x slower, with no error shown anywhere.
- **Stay plugged in and awake.** On battery, macOS caps clocks; system sleep
  stops mining outright.

## Distribution

Chrome Web Store and Firefox AMO both ban mining extensions outright. This is a
load-unpacked, self-hosted tool by necessity rather than by choice — which is
also why the source is here. If you're going to run a miner, you should be able
to read every line that decides where the money goes.

## Turning it off

`mobero stop`, or click Stop in the popup. If both are gone and the miner isn't:

```bash
kill $(python3 -c "import json;print(json.load(open('$HOME/.mobero/state.json'))['pid'])")
```

To uninstall entirely: `rm -rf ~/.mobero ~/.local/bin/mobero`, then delete
`com.mobero.host.json` from the `NativeMessagingHosts` folders listed in
[`install.sh`](install.sh) (under `~/Library/Application Support/…` on macOS,
`~/.config/…` on Linux).

## License

MIT — see [LICENSE](LICENSE).

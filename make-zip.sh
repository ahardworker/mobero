#!/usr/bin/env bash
# Package MOBero into a single MOBero.zip you can hand to anyone.
#
# The zip unpacks to a MOBero/ folder with the double-click launcher on top,
# plain-language instructions, and everything the installer needs. It does NOT
# bundle Node or xmrig — those are fetched/built on first run — so the zip stays
# small and works on both macOS and Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/MOBero.zip"
STAGE="$(mktemp -d)"
APP="$STAGE/MOBero"
trap 'rm -rf "$STAGE"' EXIT

say() { printf '\033[38;5;208m»\033[0m %s\n' "$1"; }

command -v zip >/dev/null 2>&1 || { echo "zip not found — install it and re-run" >&2; exit 1; }

mkdir -p "$APP"

# What a recipient actually needs — no .git, no web/ (that's the hosted
# curl-installer, irrelevant to a handout), no this script, no prior build.
say "staging files…"
cp -R "$ROOT/host"        "$APP/host"
cp -R "$ROOT/extension"   "$APP/extension"
cp    "$ROOT/install.sh"  "$APP/install.sh"
cp    "$ROOT/mobero.command" "$APP/mobero.command"
cp    "$ROOT/MOBero.desktop" "$APP/MOBero.desktop"
cp    "$ROOT/README.md"   "$APP/README.md"
cp    "$ROOT/LICENSE"     "$APP/LICENSE"

# Executable bits the double-click and installer rely on.
chmod +x "$APP/mobero.command" "$APP/install.sh" "$APP/host/"*.js "$APP/host/"*.sh 2>/dev/null || true

# ------------------------------------------------------ human-first instructions
cat > "$APP/READ ME FIRST.txt" <<'TXT'
🎩  MOBero — mine Monero to your own wallet

WHAT THIS IS
  A one-click Monero miner. You paste your own XMR address; the mining pool pays
  that address directly. MOBero has no wallet, no fee, and no server — every hash
  is yours.

BEFORE YOU START (one-time)
  You need Node.js installed:
    • macOS:  install from https://nodejs.org  (or:  brew install node)
    • Linux:  sudo apt install nodejs   (or your distro's package)

TO RUN
  macOS
    1. Double-click  "mobero.command".
    2. First time only: macOS may say it's from an unidentified developer.
       Right-click the file → Open → Open. (You only do this once.)
    3. Paste your Monero address when asked. It's remembered after that.

  Linux
    1. In a terminal, from this folder:   bash ./mobero.command
       (or double-click "MOBero.desktop" and allow it to launch)
    2. Paste your Monero address when asked.

  The FIRST run downloads or builds the miner (xmrig) — that can take a few
  minutes. After that, starting is instant.

WHILE MINING
  A live window shows your hashrate. Close it and mining keeps running in the
  background. To stop, run:   ~/.local/bin/mobero stop
  (or just double-click the launcher again for the live view).

PREFER THE TERMINAL?
  After the first run the "mobero" command is installed:
    mobero start        mobero status --watch        mobero stop

TO UNINSTALL
  Delete this folder, then:  rm -rf ~/.mobero ~/.local/bin/mobero

Full details and the browser-extension option are in README.md.
TXT

# ---------------------------------------------------------------------- zip it
rm -f "$OUT"
say "zipping…"
# -X drops macOS resource-fork/extra attributes; exclude junk if any slipped in.
( cd "$STAGE" && zip -r -X -q "$OUT" MOBero -x '*.DS_Store' -x '__MACOSX/*' )

SIZE="$(du -h "$OUT" | cut -f1 | tr -d ' ')"
say "built $OUT ($SIZE)"
say "unzips to a MOBero/ folder — double-click mobero.command inside it"

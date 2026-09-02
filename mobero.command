#!/usr/bin/env bash
# MOBero — portable double-click launcher (macOS + Linux).
#
# Double-click this file:
#   - macOS: Finder opens it in Terminal automatically.
#   - Linux: use the bundled "MOBero.desktop", or run `bash mobero.command`.
#
# It is fully portable: everything it creates lives under ~/.mobero, it needs
# no PATH changes and no system install, and it runs from wherever this folder
# sits. On first run it asks for your Monero address (in a dialog if one is
# available, otherwise in the terminal) and remembers it. After that, one click
# starts mining.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$ROOT/host/mobero-cli.js"
STATE_DIR="$HOME/.mobero"
OS="$(uname -s)"

orange() { printf '\033[38;5;208m%s\033[0m\n' "$1"; }
say()    { printf '\033[38;5;208m»\033[0m %s\n' "$1"; }
warn()   { printf '\033[33m!\033[0m %s\n' "$1"; }
pause()  { printf '\n'; read -r -p "Press return to close… " _ || true; }

orange "  🎩  MOBero"
echo

# --------------------------------------------------------------- prerequisites
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  warn "Node.js isn't installed — MOBero needs it to run."
  if [ "$OS" = "Darwin" ]; then
    warn "Install it with:  brew install node   (or from https://nodejs.org)"
  else
    warn "Install it with your package manager, e.g.  sudo apt install nodejs"
  fi
  pause; exit 1
fi

# Make sure xmrig + the CLI are set up. install.sh is idempotent, so we only run
# it when the miner isn't ready yet — keeps the common (already-installed) click
# instant instead of re-running a full install every time.
ensure_installed() {
  if ! "$NODE" "$CLI" probe 2>/dev/null | grep -q 'xmrig:'; then
    say "First run — setting up the miner (this can take a few minutes)…"
    bash "$ROOT/install.sh" || { warn "setup failed — see the messages above"; pause; exit 1; }
    echo
  fi
}

# ------------------------------------------------------------------ the wallet
# Prompt with a native dialog when we have one, so a double-click needs no
# terminal typing; fall back to a terminal read otherwise.
prompt_wallet() {
  local addr=""
  if [ "$OS" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    addr="$(osascript -e 'text returned of (display dialog "Paste your Monero (XMR) address — the pool pays it directly." default answer "" with title "MOBero" buttons {"Cancel","Start mining"} default button "Start mining")' 2>/dev/null || true)"
  elif command -v zenity >/dev/null 2>&1; then
    addr="$(zenity --entry --title=MOBero --text='Paste your Monero (XMR) address:' 2>/dev/null || true)"
  elif command -v kdialog >/dev/null 2>&1; then
    addr="$(kdialog --title MOBero --inputbox 'Paste your Monero (XMR) address:' 2>/dev/null || true)"
  else
    printf 'Paste your Monero (XMR) address: '
    read -r addr || true
  fi
  printf '%s' "$addr"
}

# ------------------------------------------------------------------------- run
ensure_installed

# Already mining? Just show the live view.
if "$NODE" "$CLI" status 2>/dev/null | grep -q 'mining'; then
  say "Already mining — showing live stats (close this window to leave it running)."
  echo
  "$NODE" "$CLI" status --watch
  exit 0
fi

# Do we have a saved address?
SAVED="$("$NODE" "$CLI" wallet 2>/dev/null | grep -o '4[0-9A-Za-z]\{94,105\}' || true)"
if [ -z "$SAVED" ]; then
  ADDR="$(prompt_wallet)"
  [ -n "$ADDR" ] || { warn "No address entered — nothing to mine to."; pause; exit 1; }
  "$NODE" "$CLI" wallet "$ADDR" || { warn "that didn't look like a Monero address"; pause; exit 1; }
fi

echo
"$NODE" "$CLI" start || { pause; exit 1; }
echo
say "Mining. Live stats below — close this window and it keeps going."
say "To stop later: double-click again gives you the live view, or run: mobero stop"
echo
sleep 2
"$NODE" "$CLI" status --watch

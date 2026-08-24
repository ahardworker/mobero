#!/usr/bin/env bash
# MOBero installer — curl -fsSL https://mobero.org/install.sh | sh
#
# Downloads the extension + native host, produces a working native xmrig
# (with TLS) on Apple Silicon — or finds an existing good one — and
# registers the host with your browser. It does not start mining, and it
# never asks for a wallet: you paste that into the extension yourself.
set -euo pipefail

ORIGIN="${MOBERO_ORIGIN:-https://mobero.org}"
# Chrome's "Load unpacked" opens the macOS folder picker, which hides dotfolders.
# An extension installed under ~/.mobero is therefore invisible at exactly the
# moment the user is told to go click on it. Runtime state stays hidden; the
# thing a human has to find does not.
DEST="$HOME/MOBero"
BIN_DIR="$HOME/.mobero/bin"
HOST_ID="com.mobero.host"
EXT_ID="bgnkdiknnhpffnhhehnbodmnjcgbjoap"
ARCH="$(uname -m)"

say()  { printf '\033[38;5;208m»\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only for now — Linux support is not written yet"
command -v node >/dev/null 2>&1 || die "node not found — install Node.js first (brew install node)"
command -v curl >/dev/null 2>&1 || die "curl not found"

# A candidate xmrig qualifies if it runs, speaks TLS, and its Mach-O slice
# set includes the host arch. Universal binaries qualify (both listed; we
# only need the host one).
tls_ok()  { [ -x "$1" ] && "$1" --help 2>&1 | grep -q -- '--tls'; }
arch_ok() { [ -x "$1" ] && lipo -archs "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "$ARCH"; }
ready()   { tls_ok "$1" && arch_ok "$1"; }

# ------------------------------------------------------------------ download
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "downloading MOBero…"
curl -fsSL "$ORIGIN/mobero.tar.gz" -o "$TMP/mobero.tar.gz"

if curl -fsSL "$ORIGIN/mobero.tar.gz.sha256" -o "$TMP/expected" 2>/dev/null; then
  actual="$(shasum -a 256 "$TMP/mobero.tar.gz" | cut -d' ' -f1)"
  expected="$(tr -d '[:space:]' < "$TMP/expected")"
  [ "$actual" = "$expected" ] || die "checksum mismatch — refusing to install (got $actual)"
  say "checksum verified"
else
  warn "no checksum published; continuing unverified"
fi

# Pull just the build script out — no reason to unpack everything else yet.
tar -xzf "$TMP/mobero.tar.gz" -C "$TMP" host/build-xmrig-arm64.sh 2>/dev/null || true
BUILD_SH="$TMP/host/build-xmrig-arm64.sh"

# --------------------------------------------- pick a binary, or build one
XMRIG=""
for c in "$BIN_DIR/xmrig" /opt/homebrew/bin/xmrig /usr/local/bin/xmrig "$(command -v xmrig 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  if ready "$c"; then XMRIG="$c"; break; fi
done

if [ -z "$XMRIG" ]; then
  if [ "$ARCH" = "arm64" ]; then
    if [ -f "$BUILD_SH" ]; then
      say "no native TLS xmrig on this machine — building one (a few minutes)…"
      if ! bash "$BUILD_SH"; then
        die "native build failed — install Xcode CLT (xcode-select --install) and a native openssl@3 (brew install openssl@3), then re-run"
      fi
      XMRIG="$BIN_DIR/xmrig"
      ready "$XMRIG" || die "build finished but the binary still is not ready — see the log above"
    else
      die "the tarball is missing host/build-xmrig-arm64.sh — install from a repo checkout instead: git clone <repo> && cd <repo> && ./install.sh"
    fi
  else
    # On Intel Macs there is no translation penalty to hide from, so brew works.
    command -v brew >/dev/null 2>&1 || die "no xmrig found and homebrew is unavailable — install xmrig manually"
    say "no xmrig found — installing via homebrew…"
    brew install xmrig
    XMRIG="$(command -v xmrig || echo /usr/local/bin/xmrig)"
    if ! tls_ok "$XMRIG"; then
      warn "that brew xmrig lacks --TLS — most pools will show 0 H/s"
      warn "for a TLS build, use the local repo installer instead: git clone <repo> && cd <repo> && ./install.sh"
    fi
  fi
fi
say "xmrig: $XMRIG"

# ------------------------------------------------------------------ install
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/mobero.tar.gz" -C "$DEST"
say "installed to $DEST"

# Earlier builds unpacked into ~/.mobero/app, where the folder picker could not
# see it. Clear it out so nobody loads a stale copy from the old location.
if [ -d "$HOME/.mobero/app" ]; then
  rm -rf "$HOME/.mobero/app"
  say "removed the old hidden install at ~/.mobero/app"
fi

HOST_JS="$DEST/host/mobero-host.js"
[ -f "$HOST_JS" ] || die "archive is missing host/mobero-host.js"

# The browser launches the host with a minimal PATH — pin the interpreter.
NODE="$(command -v node)"
tmp_js="$(mktemp)"
{ printf '#!%s\n' "$NODE"; tail -n +2 "$HOST_JS"; } > "$tmp_js"
mv "$tmp_js" "$HOST_JS"
chmod +x "$HOST_JS"

# ------------------------------------------------------- register the host
MANIFEST=$(cat <<JSON
{
  "name": "$HOST_ID",
  "description": "MOBero mining host",
  "path": "$HOST_JS",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)

TARGETS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

installed=0
for dir in "${TARGETS[@]}"; do
  [ -d "$(dirname "$dir")" ] || continue
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST" > "$dir/$HOST_ID.json"
  say "registered for $(basename "$(dirname "$dir")")"
  installed=$((installed + 1))
done

[ "$installed" -gt 0 ] || die "no supported Chromium browser found"

cat <<EOF

  $(printf '\033[38;5;208m%s\033[0m' "Almost there — one manual step.")

  Chrome and Firefox both ban mining extensions from their stores,
  so MOBero has to be loaded by hand:

    1. open  chrome://extensions
    2. turn on  Developer mode   (top right)
    3. click  Load unpacked
    4. choose:  $DEST/extension
       (it's the MOBero folder in your home folder — if the picker
        opens somewhere else, press ⌘⇧G and paste that path)
    5. check the ID reads  $EXT_ID

  Then click the mobster, paste your Monero address, press Start.
  Nothing mines until you do.

  Uninstall:  rm -rf $DEST ~/.mobero  and remove $HOST_ID.json from
  the NativeMessagingHosts folders above.

EOF
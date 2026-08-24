#!/usr/bin/env bash
# Installs the MOBero native messaging host so the extension can drive xmrig.
#
# Preference order: an existing binary that is both arch-native and
# TLS-capable; otherwise a fresh native build; otherwise nothing — a
# Rosetta or no-TLS xmrig is the silent 0-hash-rate dead end this project
# exists to remove, so we warn about it loudly instead of hiding behind it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_ID="com.mobero.host"
EXT_ID="bgnkdiknnhpffnhhehnbodmnjcgbjoap"
HOST_JS="$ROOT/host/mobero-host.js"
BIN_DIR="$HOME/.mobero/bin"
ARCH="$(uname -m)"

say() { printf '\033[38;5;208m»\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$HOST_JS" ] || die "host/mobero-host.js is missing"

# ---------------------------------------------------------------- node + xmrig

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found — install Node.js first (brew install node)"
say "node: $NODE"

tls_ok()  { [ -x "$1" ] && "$1" --help 2>&1 | grep -q -- '--tls'; }
arch_ok() { [ -x "$1" ] && lipo -archs "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "$ARCH"; }
ready()   { tls_ok "$1" && arch_ok "$1"; }
CANDIDATES=(
  "$BIN_DIR/xmrig"
  /opt/homebrew/bin/xmrig
  /usr/local/bin/xmrig
  "$(command -v xmrig 2>/dev/null || true)"
)

XMRIG_BIN=""
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  if ready "$c"; then XMRIG_BIN="$c"; break; fi
done

BUILD_SCRIPT="$ROOT/host/build-xmrig-arm64.sh"

if [ -z "$XMRIG_BIN" ]; then
  if [ -f "$BUILD_SCRIPT" ]; then
    say "no $ARCH-native TLS xmrig found — building one (a few minutes)…"
    if bash "$BUILD_SCRIPT"; then
      XMRIG_BIN="$BIN_DIR/xmrig"
      ready "$XMRIG_BIN" || die "the build finished but the binary still is not usable"
      say "built a native $ARCH xmrig with TLS at $XMRIG_BIN"
    else
      warn "native build failed — you will need to fix the toolchain, then re-run:"
      warn "  $BUILD_SCRIPT"
    fi
  elif command -v brew >/dev/null 2>&1; then
    say "no good xmrig and no local build script — falling back to brew (may lack TLS or be Rosetta)…"
    brew install xmrig
    XMRIG_BIN="$(command -v xmrig || echo /usr/local/bin/xmrig)"
  fi
fi

if [ -z "$XMRIG_BIN" ]; then
  # Last resort: use something that at least runs, and say exactly what is
  # missing about it instead of failing the whole install.
  for c in "${CANDIDATES[@]}"; do
    [ -x "$c" ] || continue
    XMRIG_BIN="$c"
    arch_ok "$c" || warn "$c is not $ARCH-native — it will run under Rosetta and mine slower"
    tls_ok "$c"  || warn "$c lacks --tls — most pools will show zero hash rate"
    break
  done
fi

[ -n "$XMRIG_BIN" ] && [ -x "$XMRIG_BIN" ] || die "no xmrig available on this machine — install one and re-run"
say "xmrig: $XMRIG_BIN"

chmod +x "$HOST_JS"

# ------------------------------------------------------- native host manifests

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
  parent="$(dirname "$dir")"
  [ -d "$parent" ] || continue          # browser not installed
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST" > "$dir/$HOST_ID.json"
  say "registered for $(basename "$parent")"
  installed=$((installed + 1))
done

[ "$installed" -gt 0 ] || die "no supported Chromium browser found"

# The host is a node script, so make sure the shebang resolves for the browser,
# which launches it with a minimal PATH.
if ! head -1 "$HOST_JS" | grep -q "$NODE"; then
  tmp="$(mktemp)"
  { printf '#!%s\n' "$NODE"; tail -n +2 "$HOST_JS"; } > "$tmp"
  mv "$tmp" "$HOST_JS"
  chmod +x "$HOST_JS"
  say "pinned shebang to $NODE"
fi

cat <<EOF

$(say "done")

  Load the extension:
    1. open chrome://extensions
    2. turn on Developer mode
    3. Load unpacked  ->  $ROOT/extension
    4. confirm the ID reads $EXT_ID

  Then click the mobster, paste your XMR address, hit Start.
  Logs: ~/.mobero/xmrig.log
EOF

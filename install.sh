#!/usr/bin/env bash
# MOBero installer — macOS and Linux.
#
# Installs two things from a repo checkout:
#   1. the standalone `mobero` CLI (browser-free start/stop/status), and
#   2. the native-messaging host, so the browser extension can drive xmrig too.
#
# It finds or produces a working xmrig (TLS-capable, native architecture):
#   - an existing good binary wins,
#   - else on Apple Silicon it builds a native arm64 one (host/build-xmrig-arm64.sh),
#   - else on Linux x86_64 it downloads xmrig's official static build (has TLS),
#   - else it falls back to brew (macOS) or tells you exactly what to install.
#
# It does not start mining and never asks for a wallet — you pass that to the
# CLI or paste it into the extension yourself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_ID="com.mobero.host"
EXT_ID="bgnkdiknnhpffnhhehnbodmnjcgbjoap"
HOST_JS="$ROOT/host/mobero-host.js"
CLI_JS="$ROOT/host/mobero-cli.js"
BIN_DIR="$HOME/.mobero/bin"
CLI_DIR="$HOME/.local/bin"
OS="$(uname -s)"
ARCH="$(uname -m)"
XMRIG_VERSION="6.26.0"

say()  { printf '\033[38;5;208m»\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported OS: $OS (MOBero supports macOS and Linux)" ;;
esac

[ -f "$HOST_JS" ] || die "host/mobero-host.js is missing"
[ -f "$CLI_JS" ]  || die "host/mobero-cli.js is missing"

# ---------------------------------------------------------------- node + xmrig

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found — install Node.js 18+ first"
say "node: $NODE"

# TLS is the same check everywhere. Architecture is a macOS-only concern
# (Rosetta): on Linux there is no translation layer, so a present-and-runnable
# binary of the right ELF class is fine, and `file` is the portable probe.
tls_ok()  { [ -x "$1" ] && "$1" --help 2>&1 | grep -q -- '--tls'; }
if [ "$OS" = "Darwin" ]; then
  arch_ok() { [ -x "$1" ] && lipo -archs "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "$ARCH"; }
else
  # x86_64 -> "x86-64", aarch64/arm64 -> "aarch64"/"ARM aarch64". Be lenient:
  # if `file` can't tell us, don't reject a binary that actually runs.
  arch_ok() {
    [ -x "$1" ] || return 1
    local info; info="$(file -b "$1" 2>/dev/null || true)"
    case "$ARCH" in
      x86_64|amd64)  echo "$info" | grep -qiE 'x86-64|x86_64' || [ -z "$info" ] ;;
      aarch64|arm64) echo "$info" | grep -qiE 'aarch64|arm64'  || [ -z "$info" ] ;;
      *) true ;;
    esac
  }
fi
ready() { tls_ok "$1" && arch_ok "$1"; }

CANDIDATES=(
  "$BIN_DIR/xmrig"
  /opt/homebrew/bin/xmrig
  /usr/local/bin/xmrig
  /usr/bin/xmrig
  /snap/bin/xmrig
  "$(command -v xmrig 2>/dev/null || true)"
)

XMRIG_BIN=""
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  if ready "$c"; then XMRIG_BIN="$c"; break; fi
done

# Download xmrig's official static Linux build (ships with TLS). Only x86_64
# has an official static asset; other arches fall through to the guidance below.
download_xmrig_linux() {
  local asset url tmp
  case "$ARCH" in
    x86_64|amd64) asset="xmrig-${XMRIG_VERSION}-linux-static-x64.tar.gz" ;;
    *) return 1 ;;
  esac
  url="https://github.com/xmrig/xmrig/releases/download/v${XMRIG_VERSION}/${asset}"
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || return 1
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  say "downloading official xmrig ${XMRIG_VERSION} static build…"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$tmp/x.tgz" "$url" || return 1
  else
    wget -O "$tmp/x.tgz" "$url" || return 1
  fi
  tar -xzf "$tmp/x.tgz" -C "$tmp" || return 1
  local found; found="$(find "$tmp" -type f -name xmrig -perm -111 | head -n1)"
  [ -n "$found" ] || return 1
  mkdir -p "$BIN_DIR"
  install -m 0755 "$found" "$BIN_DIR/xmrig"
  return 0
}

BUILD_SCRIPT="$ROOT/host/build-xmrig-arm64.sh"

if [ -z "$XMRIG_BIN" ]; then
  if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ] && [ -f "$BUILD_SCRIPT" ]; then
    say "no $ARCH-native TLS xmrig found — building one (a few minutes)…"
    if bash "$BUILD_SCRIPT"; then
      XMRIG_BIN="$BIN_DIR/xmrig"
      ready "$XMRIG_BIN" || die "the build finished but the binary still is not usable"
      say "built a native $ARCH xmrig with TLS at $XMRIG_BIN"
    else
      warn "native build failed — fix the toolchain, then re-run: $BUILD_SCRIPT"
    fi
  elif [ "$OS" = "Linux" ]; then
    if download_xmrig_linux && ready "$BIN_DIR/xmrig"; then
      XMRIG_BIN="$BIN_DIR/xmrig"
      say "installed xmrig to $XMRIG_BIN"
    else
      warn "couldn't fetch a prebuilt xmrig for $ARCH."
      warn "install one your distro's way, e.g.:"
      warn "  Debian/Ubuntu: sudo apt install xmrig    (or build from github.com/xmrig/xmrig)"
      warn "  Arch:          sudo pacman -S xmrig"
      warn "then re-run this installer."
    fi
  elif command -v brew >/dev/null 2>&1; then
    say "no good xmrig and no build path — falling back to brew (may lack TLS or be Rosetta)…"
    brew install xmrig || true
    XMRIG_BIN="$(command -v xmrig || echo /usr/local/bin/xmrig)"
  fi
fi

if [ -z "$XMRIG_BIN" ]; then
  # Last resort: use anything runnable and say exactly what's wrong with it.
  for c in "${CANDIDATES[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    XMRIG_BIN="$c"
    arch_ok "$c" || warn "$c may not be native to $ARCH — it could run slower"
    tls_ok "$c"  || warn "$c lacks --tls — most pools will show zero hash rate"
    break
  done
fi

[ -n "$XMRIG_BIN" ] && [ -x "$XMRIG_BIN" ] || die "no xmrig available — install one and re-run"
say "xmrig: $XMRIG_BIN"

# ------------------------------------------------------- pin the node shebang
# The browser (and a minimal-PATH login shell) launch these scripts directly,
# so the interpreter has to be an absolute path, not `/usr/bin/env node`.
pin_shebang() {
  local file="$1"
  chmod +x "$file"
  if ! head -1 "$file" | grep -q "$NODE"; then
    local tmp; tmp="$(mktemp)"
    { printf '#!%s\n' "$NODE"; tail -n +2 "$file"; } > "$tmp"
    mv "$tmp" "$file"
    chmod +x "$file"
  fi
}
pin_shebang "$HOST_JS"
pin_shebang "$CLI_JS"

# --------------------------------------------------------- install the CLI
# A thin launcher on PATH so `mobero` works from anywhere while the real code
# stays in the checkout (edits take effect immediately, no reinstall).
mkdir -p "$CLI_DIR"
cat > "$CLI_DIR/mobero" <<EOF
#!/usr/bin/env bash
exec "$NODE" "$CLI_JS" "\$@"
EOF
chmod +x "$CLI_DIR/mobero"
say "installed CLI: $CLI_DIR/mobero"
case ":$PATH:" in
  *":$CLI_DIR:"*) ;;
  *) warn "$CLI_DIR is not on your PATH — add it, e.g.:"
     warn "  echo 'export PATH=\"$CLI_DIR:\$PATH\"' >> ~/.$(basename "${SHELL:-bash}")rc" ;;
esac

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

if [ "$OS" = "Darwin" ]; then
  TARGETS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  )
else
  TARGETS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
  )
fi

installed=0
for dir in "${TARGETS[@]}"; do
  parent="$(dirname "$dir")"
  [ -d "$parent" ] || continue          # browser not installed
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST" > "$dir/$HOST_ID.json"
  say "registered extension host for $(basename "$parent")"
  installed=$((installed + 1))
done

[ "$installed" -gt 0 ] || warn "no Chromium-family browser found — that's fine, the CLI works on its own"

BROWSERS_URL="chrome://extensions"
cat <<EOF

$(say "done")

  Standalone (no browser):
    mobero start <your-monero-address>
    mobero status --watch
    mobero stop

  Browser extension (optional — works on Chrome, Chromium, Brave, Edge):
    1. open $BROWSERS_URL
    2. turn on Developer mode
    3. Load unpacked  ->  $ROOT/extension
    4. confirm the ID reads $EXT_ID
    Then click the mobster, paste your XMR address, hit Start.

  Logs: ~/.mobero/xmrig.log   ·   host events: ~/.mobero/host.log
EOF

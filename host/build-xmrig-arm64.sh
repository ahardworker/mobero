#!/usr/bin/env bash
#
# Build XMRig for Apple Silicon with TLS and install it to ~/.mobero/bin/xmrig.
#
# Why this exists: `brew install xmrig` on an Intel (x86_64) Homebrew gives you
# a binary that runs under Rosetta — fine for everything except RandomX, where
# translation costs you a large fraction of your hashrate. And a quick self-build
# without OpenSSL ends up without `--tls`, which the host passes by default and
# the process rejects at startup (that is the "0 H/s with no reason" bug).
#
# This script does one thing: produces a native arm64 xmrig with TLS that the
# host picks up automatically — it prefers an architecture-matched binary, and
# ~/.mobero/bin/xmrig is already in its candidate list.
#
# Requirements: macOS on Apple Silicon, Xcode command line tools (clang), git,
# and an arm64-friendly static OpenSSL — Homebrew's openssl@3 works.
# cmake is self-sufficient: if no arch-correct cmake exists on the machine,
# the script downloads Kitware's universal macOS build and caches it under
# ~/.mobero/build/toolchain for future runs.
#
# Idempotent: safe to re-run; point XMRIG_VERSION at a tag to bump xmrig.

set -euo pipefail

XMRIG_VERSION="${XMRIG_VERSION:-6.26.0}"
ROOT="${HOME}/.mobero/build"
DEPS="${ROOT}/deps"
DEST_DIR="${HOME}/.mobero/bin"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
SAY() { printf '\033[38;5;208m»\033[0m %s\n' "$1"; }
TARGET_ARCH="$(uname -m)"   # arm64 (Apple Silicon) or x86_64 — the arch we actually want to ship
arch_has() { lipo -archs "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "${TARGET_ARCH}"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLCHAIN="${ROOT}/toolchain"   # shared cache for downloaded toolchain bits (cmake, …)

# The cmake on PATH may be x86_64-only Homebrew. When it runs under
# Rosetta it reports CMAKE_SYSTEM_PROCESSOR=x86_64, which pulls xmrig over to
# building its x86_64 assembly sources for an arm64 target — a guaranteed
# compile error. Every candidate must have the host arch in it; a universal
# binary passes on both.
SAY "workspace ${ROOT}"
mkdir -p "${ROOT}" "${DEPS}/include" "${DEPS}/lib" "${DEST_DIR}" "${TOOLCHAIN}"

# ------------------------------------------------------------------ cmake
# Preference order: already-downloaded toolchain cache, the repo's bundled
# universal cmake, an arch-correct cmake on PATH. None of those? Download
# Kitware's universal macOS release and cache it — a fresh clone (or a
# curl-installer user with only Intel cmake) must not need spike/native/
# to ever have existed on this machine.
CMASK=""
for candidate_cmake in \
    "${TOOLCHAIN}/cmake/CMake.app/Contents/bin/cmake" \
    "${REPO_ROOT}/spike/native/cmake-3.31.6-macos-universal/CMake.app/Contents/bin/cmake" \
    /opt/homebrew/bin/cmake \
    "$(command -v cmake 2>/dev/null || true)" \
    ; do
  [ -n "${candidate_cmake}" ] && [ -x "${candidate_cmake}" ] || continue
  if arch_has "${candidate_cmake}"; then CMASK="${candidate_cmake}"; break; fi
done

if [ -z "${CMASK}" ]; then
  CMAKE_DARWIN_VERSION="3.31.6"
  CMAKE_DL="https://github.com/Kitware/CMake/releases/download/v${CMAKE_DARWIN_VERSION}/cmake-${CMAKE_DARWIN_VERSION}-macos-universal.tar.gz"
  for dl in curl wget; do command -v "${dl}" >/dev/null 2>&1 && { DL_BIN="${dl}"; break; }; done
  [ -n "${DL_BIN:-}" ] || {
    echo "no arch-correct (${TARGET_ARCH}) cmake found and no curl/wget to fetch one —" >&2
    echo "install cmake with ${TARGET_ARCH} bits (e.g. brew install --cask cmake) and re-run" >&2
    exit 1
  }
  SAY "no ${TARGET_ARCH}-native cmake on this machine — downloading Kitware's universal build"
  TMP_DL="$(mktemp -d)"
  trap 'rm -rf "${TMP_DL}"' RETURN
  if [ "${DL_BIN}" = curl ]; then
    curl -fL --retry 3 -o "${TMP_DL}/cmake.tgz" "${CMAKE_DL}"
  else
    wget -O "${TMP_DL}/cmake.tgz" "${CMAKE_DL}"
  fi
  mkdir -p "${TMP_DL}/x"
  tar -xzf "${TMP_DL}/cmake.tgz" -C "${TMP_DL}/x"
  FOUND="$(find "${TMP_DL}/x" -name cmake -type f -path '*/CMake.app/Contents/bin/cmake' 2>/dev/null | head -n 1)"
  [ -n "${FOUND}" ] && arch_has "${FOUND}" || {
    echo "downloaded cmake not usable (or missing ${TARGET_ARCH} bits)" >&2; exit 1
  }
  # Move the whole CMake.app into the cache under a stable name.
  APP_SRC="$(dirname "$(dirname "$(dirname "$(dirname "${FOUND}")")")")"   # …/CMake.app
  rm -rf "${TOOLCHAIN}/cmake"
  cp -R "${APP_SRC}" "${TOOLCHAIN}/cmake"
  CMASK="${TOOLCHAIN}/cmake/CMake.app/Contents/bin/cmake"
  SAY "cmake installed to ${TOOLCHAIN}/cmake for future builds"
fi
[ -x "${CMASK}" ] || { echo "cmake not runnable at ${CMASK}" >&2; exit 1; }
SAY "cmake: ${CMASK}"

[ "$(uname -s)" = Darwin ] || { echo 'macOS only' >&2; exit 1; }
for tool in git make; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool" >&2; exit 1; }
done

# ------------------------------------------------------------------ source tree

if [ ! -d "${ROOT}/xmrig/.git" ]; then
  rm -rf "${ROOT}/xmrig"
  SAY "cloning xmrig (v${XMRIG_VERSION} + submodules)"
  git clone --depth 1 --recurse-submodules --shallow-submodules \
    https://github.com/xmrig/xmrig "${ROOT}/xmrig"
  ( cd "${ROOT}/xmrig" && git checkout --detach "v${XMRIG_VERSION}" )
else
  SAY "reusing xmrig source at ${ROOT}/xmrig"
fi

# libuv is found through the XMRIG_DEPS directory (see xmrig's cmake/FindUV.cmake).
# Pick a static libuv.a whose object bits include our target arch — a cached
# x86_64 archive from another tool would silently drag the whole build onto
# Rosetta, which is exactly the hashrate loss this script exists to avoid.
LIBUV_A=""
for candidate in "${REPO_ROOT}/spike/native/libuv/build/libuv.a"; do
  if [ -f "${candidate}" ] && arch_has "${candidate}"; then LIBUV_A="${candidate}"; break; fi
done

if [ -z "${LIBUV_A}" ]; then
  LIBUV_SRC="${ROOT}/libuv"
  [ -f "${LIBUV_SRC}/CMakeLists.txt" ] || {
    SAY "cloning libuv"
    git clone --depth 1 https://github.com/libuv/libuv "${LIBUV_SRC}"
  }
  (
    cd "${LIBUV_SRC}"
    rm -rf build
    "${CMASK}" -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF >/dev/null
    "${CMASK}" --build build --config Release -j "${JOBS}"
  )
  LIBUV_A="${LIBUV_SRC}/build/libuv.a"
fi

# FindUV wants uv.h in XMRIG_DEPS/include and libuv.a in XMRIG_DEPS/lib. Copy
# both from the libuv source tree — symlinks are one path off from a loop when
# source or destination is stale, and copies have no such failure mode. Note:
# xmrig also reaches into the include/uv/ subtree (uv/errno.h etc.), so stage
# the whole include/ directory, not just uv.h.
LIBUV_SRC_ROOT="$(dirname "$(dirname "${LIBUV_A}")")"
LIBUV_INC="$(find "${LIBUV_SRC_ROOT}" -maxdepth 3 -type d -name include -path '*/libuv*' 2>/dev/null | head -n 1)"
[ -n "${LIBUV_INC}" ] && [ -f "${LIBUV_INC}/uv.h" ] || { echo 'libuv include dir not found near libuv.a' >&2; exit 1; }
rm -rf "${DEPS}/include/uv" "${DEPS}/include/uv.h" "${DEPS}/lib/libuv.a"
cp "${LIBUV_INC}/uv.h" "${DEPS}/include/uv.h"
cp -R "${LIBUV_INC}/uv" "${DEPS}/include/uv"
cp "${LIBUV_A}" "${DEPS}/lib/libuv.a"
[ -f "${DEPS}/include/uv.h" ] && [ -f "${DEPS}/include/uv/errno.h" ] || { echo 'failed to stage libuv headers' >&2; exit 1; }

# ---------------------------------------------------------------------- OpenSSL
#
# We need a static OpenSSL 3 whose object bits include the target arch. Homebrew's
# /usr/local openssl is x86_64 on this box, so on Apple Silicon it must not win —
# otherwise the whole build silently compiles for Rosetta. Accept any candidate
# prefix in priority order; the first one that is both present and arch-correct.

OPENSSL_ROOT=""
if command -v brew >/dev/null 2>&1; then
  OPENSSL_CANDIDATES=(
    "$(brew --prefix --quiet openssl@3 2>/dev/null || true)"
    "$(brew --prefix --quiet openssl 2>/dev/null || true)"
  )
else
  OPENSSL_CANDIDATES=()
fi
OPENSSL_CANDIDATES+=(
  "/opt/homebrew/opt/openssl@3"
  "${CONDA_PREFIX:-$HOME/miniconda3}/pkgs/openssl-3.0.17-h4ee41c1_0"
  "${CONDA_PREFIX:-$HOME/miniconda3}/pkgs/openssl-3.0.15-h80987f9_0"
  "${CONDA_PREFIX:-$HOME/miniconda3}/pkgs/openssl-3.0.12-h1a28f6b_0"
  "${CONDA_PREFIX:-$HOME/miniconda3}"
  "/usr/local/opt/openssl@3" "/usr/local/opt/openssl"
)
for prefix in "${OPENSSL_CANDIDATES[@]}"; do
  [ -n "${prefix}" ] || continue
  [ -f "${prefix}/include/openssl/ssl.h" ] || continue
  [ -f "${prefix}/lib/libcrypto.a" ] || continue
  arch_has "${prefix}/lib/libcrypto.a" || continue
  OPENSSL_ROOT="${prefix}"; break
done
[ -n "${OPENSSL_ROOT}" ] || {
  echo "no ${TARGET_ARCH} static OpenSSL 3 found;" >&2
  echo "install one with arm64 bits (e.g. /opt/homebrew openssl@3) or set CONDA_PREFIX to a conda env with openssl 3" >&2
  exit 1
}
SAY "openssl: ${OPENSSL_ROOT}"

# xmrig's cmake/OpenSSL.cmake resets OPENSSL_ROOT_DIR to $XMRIG_DEPS, so a plain
# -DOPENSSL_ROOT_DIR is ignored. Satisfy its search the way its deps model works:
# headers under DEPS/include, static libs under DEPS/lib (it links static on macOS).
mkdir -p "${DEPS}/include" "${DEPS}/lib"
ln -sfn "${OPENSSL_ROOT}/include/openssl" "${DEPS}/include/openssl"
ln -sfn "${OPENSSL_ROOT}/lib/libssl.a" "${DEPS}/lib/libssl.a"
ln -sfn "${OPENSSL_ROOT}/lib/libcrypto.a" "${DEPS}/lib/libcrypto.a"
[ -f "${DEPS}/include/openssl/ssl.h" ] || { echo 'openssl symlinks broken' >&2; exit 1; }
# ----------------------------------------------------------------------- build

BUILD_DIR="${ROOT}/build-${XMRIG_VERSION}"
CACHE_ARCH="$(grep -E '^CMAKE_OSX_ARCHITECTURES:STRING=' "${BUILD_DIR}/CMakeCache.txt" 2>/dev/null | sed 's/.*://' || true)"
# Wipe the cache whenever it was not configured for this machine's native arch —
# including when it was left empty (CMake's default is "whatever the deps say",
# which is how a stale x86_64 configuration can silently survive to the next run).
if [ -d "${BUILD_DIR}" ] && { [ -z "${CACHE_ARCH}" ] || [ "${CACHE_ARCH}" != "${TARGET_ARCH}" ]; }; then
  SAY "stale cache not targeting ${TARGET_ARCH} — wiping ${BUILD_DIR}"
  rm -rf "${BUILD_DIR}"
fi
if [ -d "${BUILD_DIR}" ] && ! grep -q 'WITH_TLS:BOOL=ON' "${BUILD_DIR}/CMakeCache.txt" 2>/dev/null; then
  SAY 'old configuration in build dir had TLS off — wiping and reconfiguring'
  rm -rf "${BUILD_DIR}"
fi

if [ ! -f "${BUILD_DIR}/CMakeCache.txt" ]; then
  SAY "configuring (${TARGET_ARCH}, native arch, TLS on)"
  "${CMASK}" -S "${ROOT}/xmrig" -B "${BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="${TARGET_ARCH}" \
    -DCMAKE_SYSTEM_PROCESSOR="${TARGET_ARCH}" \
    -DWITH_TLS=ON \
    -DWITH_OPENCL=OFF \
    -DWITH_CUDA=OFF \
    -DWITH_HWLOC=OFF \
    -DWITH_BENCHMARK=ON \
    -DXMRIG_DEPS="${DEPS}"
fi

SAY "building with ${JOBS} jobs (a few minutes)"
"${CMASK}" --build "${BUILD_DIR}" --config Release -j "${JOBS}"

BIN="$(find "${BUILD_DIR}" -maxdepth 2 -type f -name xmrig -perm -111 2>/dev/null | head -n 1)"
[ -n "${BIN}" ] || { echo 'built binary not found' >&2; exit 1; }

BUILD_ARCH="$(lipo -archs "${BIN}" 2>/dev/null || echo unknown)"
SAY "built: ${BIN} (${BUILD_ARCH})"
# Hard guard: a wrong-arch binary is the whole class of bug this script targets.
arch_has "${BIN}" || {
  echo "built binary is ${BUILD_ARCH}; refusing to install (wanted ${TARGET_ARCH})" >&2
  exit 1
}
"${BIN}" --version | head -n 1

# The two guarantees a bad past build broke: TLS is in, and the binary runs.
if ! "${BIN}" --help 2>&1 | grep -q -- '--tls'; then
  echo 'build does not advertise --tls; refusing to install' >&2
  exit 1
fi
SAY '--tls: supported'

install -m 0755 "${BIN}" "${DEST_DIR}/xmrig"
"${DEST_DIR}/xmrig" --version >/dev/null

SAY "installed to ${DEST_DIR}/xmrig as ${TARGET_ARCH} — the host (and your next Start) will use it"
#!/bin/sh
# One-shot Zedge health diagnosis with copy-paste fixes.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)
FAT_STATION_RELEASE="${WORKSPACE_ROOT}/open-source/gnosis/distributed-inference/target/release/fat-station-memo"
FAT_STATION_DEBUG="${WORKSPACE_ROOT}/open-source/gnosis/distributed-inference/target/debug/fat-station-memo"
DEFAULT_KNOT="${WORKSPACE_ROOT}/open-source/bitwise/datasets/llama1b_fixed.knot"
MIN_FREE_MB=2048

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

issues=0
add_issue() {
  issues=$((issues + 1))
  red "  ✗ $1"
}

ok() {
  green "  ✓ $1"
}

echo "Zedge doctor"
echo "============"
echo

echo "Disk (need at least ${MIN_FREE_MB} MB free on /System/Volumes/Data):"
avail_kb=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2 {print $4}')
if [ -z "${avail_kb}" ]; then
  yellow "  ? could not read disk free space"
else
  avail_mb=$((avail_kb / 1024))
  used_pct=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')
  if [ "${avail_mb}" -lt "${MIN_FREE_MB}" ]; then
    add_issue "only ${avail_mb} MB free — free space before building fat-station or pulling Docker images"
    echo "      Tip: empty Trash, remove old Xcode simulators, or run: pnpm run a0 -- clean disk --modules"
  else
    ok "${avail_mb} MB free"
    if [ -n "${used_pct}" ] && [ "${used_pct}" -ge 95 ] 2>/dev/null; then
      yellow "  ○ disk ${used_pct}% full — builds and knot downloads may fail soon"
    fi
  fi
fi
echo

echo "Companion sidecar (http://127.0.0.1:7331):"
if curl -fsS -m 3 "http://127.0.0.1:7331/health" >/dev/null 2>&1; then
  ok "listening on :7331"
else
  add_issue "not reachable on :7331"
  echo "      Fix: pnpm run zedge:launch-agent:install   # once"
  echo "            pnpm run zedge:restart"
fi
echo

echo "Moonshine inference (http://127.0.0.1:8080):"
if curl -fsS -m 3 "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
  ok "healthy on :8080"
else
  add_issue "not healthy on :8080 (Zed agent mode needs this)"
fi
echo

echo "Local fat-station binary:"
if [ -x "${FAT_STATION_RELEASE}" ]; then
  ok "release binary present"
elif [ -x "${FAT_STATION_DEBUG}" ]; then
  ok "debug binary present"
else
  add_issue "fat-station-memo not built"
  echo "      Fix (after freeing disk): pnpm run a0 -- run distributed-inference:build"
  echo "      Note: a0 clean artifacts spares open-source/gnosis/distributed-inference/target"
fi
echo

echo "Moonshine WASM deps (openai-compat shim):"
VOICE_TTS_NODE="${WORKSPACE_ROOT}/wasm-modules/voice-tts/pkg-node/voice_tts.js"
VOICE_STT_NODE="${WORKSPACE_ROOT}/wasm-modules/voice-stt/pkg-node/voice_stt.js"
if [ -f "${VOICE_TTS_NODE}" ] && [ -f "${VOICE_STT_NODE}" ]; then
  ok "voice-tts + voice-stt node WASM built"
else
  add_issue "voice-tts/voice-stt pkg-node missing (openai-compat on :8080 will crash)"
  echo "      Fix: cd wasm-modules/voice-tts && wasm-pack build --target nodejs --release --out-dir pkg-node"
  echo "            cd wasm-modules/voice-stt && wasm-pack build --target nodejs --release --out-dir pkg-node"
fi
echo

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "daemon running (compose fallback available)"
else
  yellow "  ○ Docker daemon not running (optional if local binary is built)"
fi
echo

echo "Offline Moonshine default (qwen2.5-0.5b-instruct):"
OFFLINE_KNOT="${HOME}/.edgework/models/qwen2.5-0.5b-instruct.knot"
OFFLINE_GGUF="${HOME}/.edgework/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"
if [ -f "${OFFLINE_KNOT}" ]; then
  ok "${OFFLINE_KNOT} present"
else
  yellow "  ○ ${OFFLINE_KNOT} missing — launch agent needs this for offline inference"
fi
if [ -f "${OFFLINE_GGUF}" ]; then
  ok "${OFFLINE_GGUF} present (tokenizer)"
else
  yellow "  ○ ${OFFLINE_GGUF} missing — Moonshine needs the GGUF for Qwen chat tokenization"
fi
echo

echo "Legacy gnosis-local knot:"
if [ -f "${DEFAULT_KNOT}" ]; then
  ok "llama1b_fixed.knot present"
else
  yellow "  ○ ${DEFAULT_KNOT} missing (Moonshine can stream knots from R2 for mesh models)"
fi
echo

if curl -fsS -m 5 "http://127.0.0.1:7331/probe/doctor" >/dev/null 2>&1; then
  echo "Companion probe:"
  curl -fsS -m 8 "http://127.0.0.1:7331/probe/doctor" | sed 's/^/  /'
  echo
fi

if curl -fsS -m 5 "http://127.0.0.1:7331/probe/ready" >/dev/null 2>&1; then
  echo "Ready probe:"
  curl -fsS -m 8 "http://127.0.0.1:7331/probe/ready" | sed 's/^/  /'
  echo
  curl -fsS -m 10 -X POST "http://127.0.0.1:7331/zed/settings/sync" >/dev/null 2>&1 && \
    green "Synced Zedge keychain + settings via companion" || \
    yellow "Companion sync failed — seeding keychain directly"
  seed_zed_keychain_direct() {
    security add-internet-password -a Bearer -s "http://127.0.0.1:7331/v1" -w zedge-local -U >/dev/null 2>&1 || true
  }
  seed_zed_keychain_direct
  echo
fi

echo "Zed provider access (auto-written by companion on startup):"
echo "  Base URL: http://127.0.0.1:7331/v1  (settings.json — use 127.0.0.1, not localhost)"
echo "  API key:  zedge-local in macOS Keychain + ZEDGE_API_KEY env (NOT settings.json api_key)"
echo

if [ "${issues}" -eq 0 ]; then
  green "All critical checks passed."
  exit 0
fi

echo
yellow "${issues} issue(s) need attention. Quick path:"
echo "  1. Free disk space (see above)"
echo "  2. Either start Docker Desktop, OR build fat-station (step 1 first)"
echo "  3. pnpm run zedge:restart"
echo "  4. Re-open Zed agent panel"
exit 1

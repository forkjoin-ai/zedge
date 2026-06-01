#!/bin/sh
# One-shot Zedge health diagnosis; use --fix to repair Moonshine + sync Zed.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)
LAUNCH_AGENT="${SCRIPT_DIR}/companion-launch-agent.sh"
FAT_STATION_RELEASE="${WORKSPACE_ROOT}/open-source/gnosis/distributed-inference/target/release/fat-station-memo"
FAT_STATION_DEBUG="${WORKSPACE_ROOT}/open-source/gnosis/distributed-inference/target/debug/fat-station-memo"
DEFAULT_KNOT="${WORKSPACE_ROOT}/open-source/bitwise/datasets/llama1b_fixed.knot"
OFFLINE_MODEL="qwen2.5-0.5b-instruct"
OFFLINE_KNOT="${HOME}/.edgework/models/${OFFLINE_MODEL}.knot"
OFFLINE_GGUF="${HOME}/.edgework/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"
MIN_FREE_MB=2048
COMPANION_URL="http://127.0.0.1:7331"
MOONSHINE_URL="http://127.0.0.1:8080"
FAT_STATION_URL="http://127.0.0.1:8000"
ERR_LOG="/tmp/zedge-sidecar-launchd.err.log"

DO_FIX=0
for arg in "$@"; do
  case "${arg}" in
    --fix) DO_FIX=1 ;;
    -h|--help)
      echo "Usage: zedge-doctor.sh [--fix]"
      echo "  (default)  Diagnose companion :7331, Moonshine :8080, fat-station :8000"
      echo "  --fix      Repair via companion API or launch-agent restart, then smoke-test"
      exit 0
      ;;
  esac
done

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

issues=0
needs_repair=0
add_issue() {
  issues=$((issues + 1))
  needs_repair=1
  red "  ✗ $1"
}

ok() {
  green "  ✓ $1"
}

moonshine_ready() {
  if command -v jq >/dev/null 2>&1; then
    curl -fsS -m 5 "${COMPANION_URL}/probe/ready" 2>/dev/null \
      | jq -e '.ready == true and .checks.moonshine.ready == true' >/dev/null 2>&1
    return $?
  fi
  curl -fsS -m 5 "${COMPANION_URL}/probe/ready" 2>/dev/null \
    | grep -q '"ready":true' && \
    curl -fsS -m 5 "${COMPANION_URL}/probe/ready" 2>/dev/null \
    | grep -q '"moonshine"' && \
    curl -fsS -m 5 "${COMPANION_URL}/probe/ready" 2>/dev/null \
    | grep -q '"ready":true'
}

wait_moonshine_ready() {
  max_polls="${1:-45}"
  poll=0
  while [ "${poll}" -lt "${max_polls}" ]; do
    poll=$((poll + 1))
    if moonshine_ready; then
      return 0
    fi
    sleep 2
  done
  return 1
}

smoke_chat() {
  curl -fsS -m 120 -X POST "${COMPANION_URL}/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${OFFLINE_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"max_tokens\":8,\"stream\":false}" \
    2>/dev/null | sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | head -1
}

run_repair() {
  yellow "Repairing Moonshine stack..."
  if curl -fsS -m 3 "${COMPANION_URL}/health" >/dev/null 2>&1; then
    repair_body=$(curl -fsS -m 180 -X POST "${COMPANION_URL}/probe/doctor/repair" 2>/dev/null || true)
    if [ -n "${repair_body}" ]; then
      echo "${repair_body}" | sed 's/^/  /'
      if echo "${repair_body}" | grep -q '"ok":true'; then
        ok "companion repair endpoint succeeded"
        return 0
      fi
      if echo "${repair_body}" | grep -q '"deferred":true'; then
        yellow "  ○ repair deferred (chat in progress) — wait and re-run: pnpm run zedge:doctor -- --fix"
        return 1
      fi
    fi
    yellow "  ○ companion repair API failed; falling back to launch-agent restart"
  fi

  if [ -x "${LAUNCH_AGENT}" ]; then
    "${LAUNCH_AGENT}" restart
    if wait_moonshine_ready 60; then
      ok "launch-agent restart + moonshine ready"
      return 0
    fi
    add_issue "moonshine not ready after launch-agent restart"
    return 1
  fi

  add_issue "cannot repair (companion down and launch-agent script missing)"
  return 1
}

echo "Zedge doctor"
echo "============"
if [ "${DO_FIX}" -eq 1 ]; then
  yellow "Mode: diagnose + repair (--fix)"
else
  echo "Mode: diagnose only (pass --fix to repair)"
fi
echo

echo "Launch agent model (ZEDGE_MOONSHINE_MODEL):"
if [ -f "${HOME}/Library/LaunchAgents/ai.forkjoin.zedge.sidecar.plist" ]; then
  launch_model=$(grep -A1 'ZEDGE_MOONSHINE_MODEL' "${HOME}/Library/LaunchAgents/ai.forkjoin.zedge.sidecar.plist" 2>/dev/null | tail -1 | sed 's/.*<string>\(.*\)<\/string>.*/\1/' || true)
  if [ -n "${launch_model}" ]; then
    if [ "${launch_model}" = "${OFFLINE_MODEL}" ]; then
      ok "${launch_model}"
    else
      yellow "  ○ plist has ${launch_model} (recommended: ${OFFLINE_MODEL})"
      yellow "      Fix: pnpm run zedge:launch-agent:install"
    fi
  else
    yellow "  ○ ZEDGE_MOONSHINE_MODEL not set in plist"
  fi
else
  yellow "  ○ launch agent plist not installed"
  echo "      Fix: pnpm run zedge:launch-agent:install"
fi
echo

echo "Disk (need at least ${MIN_FREE_MB} MB free on /System/Volumes/Data):"
avail_kb=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2 {print $4}')
if [ -z "${avail_kb}" ]; then
  yellow "  ? could not read disk free space"
else
  avail_mb=$((avail_kb / 1024))
  used_pct=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')
  if [ "${avail_mb}" -lt "${MIN_FREE_MB}" ]; then
    add_issue "only ${avail_mb} MB free — free space before building fat-station"
    echo "      Tip: pnpm run a0 -- clean disk --modules"
  else
    ok "${avail_mb} MB free"
    if [ -n "${used_pct}" ] && [ "${used_pct}" -ge 95 ] 2>/dev/null; then
      yellow "  ○ disk ${used_pct}% full — builds may fail soon"
    fi
  fi
fi
echo

echo "Companion sidecar (${COMPANION_URL}):"
if curl -fsS -m 3 "${COMPANION_URL}/health" >/dev/null 2>&1; then
  ok "listening on :7331"
else
  add_issue "not reachable on :7331"
fi
echo

echo "Fat-station (${FAT_STATION_URL}):"
if curl -fsS -m 3 "${FAT_STATION_URL}/health" >/dev/null 2>&1; then
  ok "healthy on :8000"
else
  add_issue "not healthy on :8000"
fi
echo

echo "Moonshine OpenAI shim (${MOONSHINE_URL}):"
if curl -fsS -m 3 "${MOONSHINE_URL}/health" >/dev/null 2>&1; then
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
  echo "      Fix: pnpm run a0 -- run distributed-inference:build"
fi
echo

echo "Moonshine WASM deps (openai-compat shim):"
VOICE_TTS_NODE="${WORKSPACE_ROOT}/wasm-modules/voice-tts/pkg-node/voice_tts.js"
VOICE_STT_NODE="${WORKSPACE_ROOT}/wasm-modules/voice-stt/pkg-node/voice_stt.js"
if [ -f "${VOICE_TTS_NODE}" ] && [ -f "${VOICE_STT_NODE}" ]; then
  ok "voice-tts + voice-stt node WASM built"
else
  add_issue "voice-tts/voice-stt pkg-node missing (openai-compat may crash)"
  echo "      Fix: cd wasm-modules/voice-tts && wasm-pack build --target nodejs --release --out-dir pkg-node"
  echo "            cd wasm-modules/voice-stt && wasm-pack build --target nodejs --release --out-dir pkg-node"
fi
echo

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "Docker daemon running (compose fallback available)"
else
  yellow "  ○ Docker daemon not running (optional if local binary is built)"
fi
echo

echo "Offline Moonshine default (${OFFLINE_MODEL}):"
if [ -f "${OFFLINE_KNOT}" ]; then
  ok "${OFFLINE_KNOT} present"
else
  add_issue "${OFFLINE_KNOT} missing"
fi
if [ -f "${OFFLINE_GGUF}" ]; then
  ok "${OFFLINE_GGUF} present (tokenizer)"
else
  add_issue "${OFFLINE_GGUF} missing (Qwen chat tokenization)"
fi
echo

echo "Legacy gnosis-local knot:"
if [ -f "${DEFAULT_KNOT}" ]; then
  ok "llama1b_fixed.knot present"
else
  yellow "  ○ ${DEFAULT_KNOT} missing (mesh models can stream from R2)"
fi
echo

if [ -f "${ERR_LOG}" ]; then
  echo "Recent sidecar errors:"
  if grep -E 'fell to ECHO|fat-station not responsive|runtime degraded' "${ERR_LOG}" 2>/dev/null | tail -3 | sed 's/^/  /'; then
    needs_repair=1
    yellow "  ○ inference fell back to echo or Moonshine was restarted mid-request"
  else
    ok "no recent echo/fat-station restart lines in ${ERR_LOG}"
  fi
  echo
fi

if curl -fsS -m 5 "${COMPANION_URL}/probe/doctor" >/dev/null 2>&1; then
  echo "Companion probe:"
  curl -fsS -m 8 "${COMPANION_URL}/probe/doctor" | sed 's/^/  /'
  echo
fi

if curl -fsS -m 5 "${COMPANION_URL}/probe/ready" >/dev/null 2>&1; then
  echo "Ready probe:"
  curl -fsS -m 8 "${COMPANION_URL}/probe/ready" | sed 's/^/  /'
  echo
  if ! moonshine_ready; then
    needs_repair=1
  fi
fi

if [ "${DO_FIX}" -eq 1 ] && [ "${needs_repair}" -ne 0 ]; then
  echo
  if run_repair; then
    if wait_moonshine_ready 30; then
      ok "moonshine ready after repair"
    fi
    echo
    echo "Zed provider sync:"
    if curl -fsS -m 10 -X POST "${COMPANION_URL}/zed/settings/sync" >/dev/null 2>&1; then
      ok "companion synced Zed keychain + settings"
    else
      yellow "  ○ companion sync failed — seeding keychain directly"
      security add-internet-password -a Bearer -s "http://127.0.0.1:7331/v1" -w zedge-local -U >/dev/null 2>&1 || true
    fi
    echo
    echo "Smoke test (hello via companion, may take ~20s on CPU):"
    reply=$(smoke_chat || true)
    if [ -n "${reply}" ] && [ "${reply}" != "Moonshine did not return a usable completion before Zedge's local echo fallback." ]; then
      ok "chat reply: ${reply}"
      issues=0
    else
      add_issue "smoke chat failed or fell to echo"
      echo "      Check: tail -20 ${ERR_LOG}"
    fi
  fi
  echo
elif [ "${DO_FIX}" -eq 1 ]; then
  echo
  ok "No repair needed — all checks passed"
  echo
fi

echo "Zed provider access:"
echo "  Base URL: http://127.0.0.1:7331/v1"
echo "  Model:    ${OFFLINE_MODEL}"
echo "  API key:  zedge-local (Keychain + ZEDGE_API_KEY, not settings.json api_key)"
echo

if [ "${issues}" -eq 0 ]; then
  green "All critical checks passed."
  if [ "${DO_FIX}" -eq 0 ] && [ "${needs_repair}" -ne 0 ]; then
    yellow "Moonshine may still be degraded — re-run with: pnpm run zedge:doctor -- --fix"
  fi
  exit 0
fi

echo
yellow "${issues} issue(s) need attention."
if [ "${DO_FIX}" -eq 0 ]; then
  echo "  Quick fix: pnpm run zedge:doctor -- --fix"
  echo "  Manual:    pnpm run zedge:launch-agent:install && pnpm run zedge:restart"
fi
exit 1

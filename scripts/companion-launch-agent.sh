#!/bin/sh
# macOS Launch Agent for the Zedge companion (supervisor + sidecar on :7331).
# Uses absolute paths to node + gnode — launchd does not load shell profile, so
# `pnpm` is often missing from PATH when the job runs.
set -eu

usage() {
  cat <<'EOF'
Usage: companion-launch-agent.sh <install|uninstall|start|stop|kill|restart|status|logs>

Commands:
  install    Create + load the launch agent and start the zedge companion.
  uninstall  Stop + unload the launch agent and remove the plist.
  start      Start the launch agent job immediately.
  stop       Stop the launch agent job immediately (unload; does not SIGKILL listeners).
  kill       Stop launch agent (if any) and SIGTERM/SIGKILL whatever is listening on :7331.
  restart    kill, then bootstrap the launch agent again if ~/Library/LaunchAgents plist exists.
  status     Print launchctl state and listener status for localhost:7331.
  logs       Tail launch-agent stdout/stderr logs.
EOF
}

if [ "$#" -lt 1 ]; then
  usage
  exit 64
fi

ACTION="$1"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "zedge: launch agent management is supported only on macOS." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)
SUPERVISOR_REL="open-source/zedge/companion/src/companion-supervisor.ts"

LABEL="ai.forkjoin.zedge.sidecar"
DIRECT_LABEL="${LABEL}.direct"
ENV_LABEL="${LABEL}.zed-env"
UID_VALUE="$(id -u)"
LAUNCH_AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENT_DIR}/${LABEL}.plist"
ENV_PLIST_PATH="${LAUNCH_AGENT_DIR}/${ENV_LABEL}.plist"
OUT_LOG="/tmp/zedge-sidecar-launchd.out.log"
ERR_LOG="/tmp/zedge-sidecar-launchd.err.log"
DOMAIN_STATE="${HOME}/.edgework/zedge-launchd-domain"
LOCAL_ZED_API_KEY="${ZEDGE_LOCAL_API_KEY:-zedge-local}"

escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Resolve node for plist (launchd has no ~/.zshrc / nvm).
resolve_node_for_plist() {
  if [ -n "${ZEDGE_NODE_RUNTIME:-}" ] && [ -x "${ZEDGE_NODE_RUNTIME}" ]; then
    printf '%s' "${ZEDGE_NODE_RUNTIME}"
    return 0
  fi
  # launchd cannot execute the repo's bin/node shim from macOS-protected
  # Documents paths. Prefer a real runtime binary before consulting PATH,
  # whose first entry is commonly the sovereign shim.
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  echo "zedge: could not find Node. Install Node or set ZEDGE_NODE_RUNTIME." >&2
  return 1
}

resolve_tsx_loader_for_plist() {
  if [ -n "${ZEDGE_TSX_LOADER:-}" ] && [ -f "${ZEDGE_TSX_LOADER}" ]; then
    printf '%s' "${ZEDGE_TSX_LOADER}"
    return 0
  fi
  for candidate in \
    "${WORKSPACE_ROOT}/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs" \
    "${WORKSPACE_ROOT}/node_modules/tsx/dist/loader.mjs"; do
    if [ -f "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  echo "zedge: could not find tsx loader. Install dependencies or set ZEDGE_TSX_LOADER." >&2
  return 1
}

read_stored_domain() {
  if [ -f "${DOMAIN_STATE}" ]; then
    d="$(tr -d '\r\n' <"${DOMAIN_STATE}" | tr -d ' ')"
    case "${d}" in
      gui/"${UID_VALUE}"|user/"${UID_VALUE}")
        printf '%s' "${d}"
        return 0
        ;;
    esac
  fi
  return 1
}

detect_loaded_domain() {
  if launchctl print "gui/${UID_VALUE}/${LABEL}" >/dev/null 2>&1; then
    printf 'gui/%s' "${UID_VALUE}"
    return 0
  fi
  if launchctl print "user/${UID_VALUE}/${LABEL}" >/dev/null 2>&1; then
    printf 'user/%s' "${UID_VALUE}"
    return 0
  fi
  return 1
}

persist_domain() {
  mkdir -p "$(dirname "${DOMAIN_STATE}")"
  printf '%s\n' "$1" >"${DOMAIN_STATE}"
}

set_zed_openai_compatible_env() {
  existing="$(launchctl getenv ZEDGE_API_KEY 2>/dev/null || true)"
  if [ -n "${existing}" ]; then
    echo "zedge: leaving existing ZEDGE_API_KEY launch environment in place"
    return 0
  fi

  launchctl setenv ZEDGE_API_KEY "${LOCAL_ZED_API_KEY}" >/dev/null 2>&1 || true
  echo "zedge: set ZEDGE_API_KEY=${LOCAL_ZED_API_KEY} for Zed's OpenAI-compatible local provider"
}

write_zed_env_plist() {
  mkdir -p "${LAUNCH_AGENT_DIR}"
  ZED_ENV_SCRIPT="existing=\$(launchctl getenv ZEDGE_API_KEY 2>/dev/null || true); if [ -z \"\${existing}\" ]; then launchctl setenv ZEDGE_API_KEY \"${LOCAL_ZED_API_KEY}\"; fi"
  cat >"${ENV_PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ENV_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$(escape_xml "${ZED_ENV_SCRIPT}")</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
  if ! plutil -lint "${ENV_PLIST_PATH}" >/dev/null 2>&1; then
    echo "zedge: env plist failed validation; run: plutil -lint ${ENV_PLIST_PATH}" >&2
    plutil -lint "${ENV_PLIST_PATH}" >&2 || true
    exit 1
  fi
}

ensure_zed_env_loaded() {
  write_zed_env_plist
  launchctl bootout "gui/${UID_VALUE}/${ENV_LABEL}" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/${UID_VALUE}" "${ENV_PLIST_PATH}" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/${UID_VALUE}/${ENV_LABEL}" >/dev/null 2>&1 || true
  else
    launchctl load -w "${ENV_PLIST_PATH}" >/dev/null 2>&1 || true
  fi
  set_zed_openai_compatible_env
}

unset_zed_openai_compatible_env_if_placeholder() {
  existing="$(launchctl getenv ZEDGE_API_KEY 2>/dev/null || true)"
  if [ "${existing}" = "${LOCAL_ZED_API_KEY}" ]; then
    launchctl unsetenv ZEDGE_API_KEY >/dev/null 2>&1 || true
  fi
}

bootout_zed_env_agent() {
  launchctl bootout "gui/${UID_VALUE}/${ENV_LABEL}" >/dev/null 2>&1 || true
  launchctl bootout "user/${UID_VALUE}/${ENV_LABEL}" >/dev/null 2>&1 || true
  launchctl unload -w "${ENV_PLIST_PATH}" >/dev/null 2>&1 || true
}

# SERVICE_TARGET and DOMAIN — set after resolve_service_target
DOMAIN=""
SERVICE_TARGET=""
JUST_BOOTSTRAPPED=0

resolve_service_target() {
  if DOMAIN="$(read_stored_domain)"; then
    SERVICE_TARGET="${DOMAIN}/${LABEL}"
    return 0
  fi
  if DOMAIN="$(detect_loaded_domain)"; then
    SERVICE_TARGET="${DOMAIN}/${LABEL}"
    return 0
  fi
  DOMAIN="gui/${UID_VALUE}"
  SERVICE_TARGET="${DOMAIN}/${LABEL}"
  return 1
}

build_companion_dist() {
  NODE_BIN="$(resolve_node_for_plist)" || return 1
  BUILD_SCRIPT="${WORKSPACE_ROOT}/open-source/zedge/companion/scripts/build-companion-dist.mjs"
  if [ ! -f "${BUILD_SCRIPT}" ]; then
    return 1
  fi
  echo "zedge: building companion dist (stable launchd binary)..."
  if ! "${NODE_BIN}" "${BUILD_SCRIPT}"; then
    echo "zedge: companion dist build failed — launch agent will use tsx fallback" >&2
    return 1
  fi
  return 0
}

write_plist() {
  NODE_BIN="$(resolve_node_for_plist)" || exit 127
  if [ ! -f "${WORKSPACE_ROOT}/${SUPERVISOR_REL}" ]; then
    echo "zedge: missing supervisor at ${WORKSPACE_ROOT}/${SUPERVISOR_REL} (wrong repo root?)" >&2
    exit 1
  fi

  COMPANION_DIST="${WORKSPACE_ROOT}/open-source/zedge/companion/dist/companion-supervisor.mjs"
  USE_DIST=0
  if [ -f "${COMPANION_DIST}" ] || build_companion_dist; then
    if [ -f "${COMPANION_DIST}" ]; then
      USE_DIST=1
    fi
  fi

  WD_XML="$(escape_xml "${WORKSPACE_ROOT}")"
  NODE_XML="$(escape_xml "${NODE_BIN}")"

  mkdir -p "${LAUNCH_AGENT_DIR}"
  if [ "${USE_DIST}" -eq 1 ]; then
    SUPERVISOR_ENTRY_XML="$(escape_xml "${COMPANION_DIST}")"
    cat >"${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_XML}</string>
    <string>${SUPERVISOR_ENTRY_XML}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${WD_XML}</string>

  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(escape_xml "${HOME}")</string>
    <key>AEON_ROOT</key>
    <string>${WD_XML}</string>
    <key>ZEDGE_COMPANION_USE_DIST</key>
    <string>0</string>
    <key>ZEDGE_API_KEY</key>
    <string>$(escape_xml "${LOCAL_ZED_API_KEY}")</string>
    <key>OPENAI_API_KEY</key>
    <string>$(escape_xml "${LOCAL_ZED_API_KEY}")</string>
    <key>ZED_OPEN_AI_COMPATIBLE_API_KEY</key>
    <string>$(escape_xml "${LOCAL_ZED_API_KEY}")</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ZEDGE_MOONSHINE_MODEL</key>
    <string>rwkv7-mini</string>
    <key>ZEDGE_MOONSHINE_TIMEOUT_MS</key>
    <string>180000</string>
    <key>ZEDGE_GUARDED_SUBAGENT</key>
    <string>0</string>
  </dict>
  </dict>
</plist>
EOF
  else
  TSX_LOADER_XML="$(escape_xml "$(resolve_tsx_loader_for_plist)")"
  SUPERVISOR_IMPORT_XML="$(escape_xml "import(\"./${SUPERVISOR_REL}\").then((m) => m.main())")"
  cat >"${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_XML}</string>
    <string>--import</string>
    <string>${TSX_LOADER_XML}</string>
    <string>-e</string>
    <string>${SUPERVISOR_IMPORT_XML}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${WD_XML}</string>

  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(escape_xml "${HOME}")</string>
    <key>AEON_ROOT</key>
    <string>${WD_XML}</string>
    <key>GNODE_FORCE_TSX</key>
    <string>1</string>
    <key>ZEDGE_API_KEY</key>
    <string>$(escape_xml "${LOCAL_ZED_API_KEY}")</string>
    <key>OPENAI_API_KEY</key>
    <string>$(escape_xml "${LOCAL_ZED_API_KEY}")</string>
    <key>ZED_OPEN_AI_COMPATIBLE_API_KEY</key>
    <string>$(escape_xml "${LOCAL_ZED_API_KEY}")</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ZEDGE_MOONSHINE_MODEL</key>
    <string>rwkv7-mini</string>
    <key>ZEDGE_MOONSHINE_TIMEOUT_MS</key>
    <string>180000</string>
    <key>ZEDGE_GUARDED_SUBAGENT</key>
    <string>0</string>
  </dict>
  </dict>
</plist>
EOF
  fi
  if ! plutil -lint "${PLIST_PATH}" >/dev/null 2>&1; then
    echo "zedge: plist failed validation; run: plutil -lint ${PLIST_PATH}" >&2
    plutil -lint "${PLIST_PATH}" >&2 || true
    exit 1
  fi
}

# Only bootout — do not use launchctl disable here; disable can leave the job in a
# state where the next bootstrap returns EIO until reboot or manual cleanup.
bootout_all() {
  launchctl bootout "gui/${UID_VALUE}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootout "user/${UID_VALUE}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${UID_VALUE}/${DIRECT_LABEL}" >/dev/null 2>&1 || true
  launchctl bootout "user/${UID_VALUE}/${DIRECT_LABEL}" >/dev/null 2>&1 || true
}

# Deprecated but still works when bootstrap returns "Input/output error" (e.g. some
# macOS / domain timing). Loads the user LaunchAgent into the login session.
bootstrap_service_legacy_load() {
  echo "zedge: trying launchctl load -w (fallback after bootstrap EIO)..." >&2
  launchctl unload -w "${PLIST_PATH}" >/dev/null 2>&1 || true
  sleep 1
  if launchctl load -w "${PLIST_PATH}" 2>/dev/null; then
    DOMAIN="gui/${UID_VALUE}"
    SERVICE_TARGET="${DOMAIN}/${LABEL}"
    persist_domain "${DOMAIN}"
    launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
    echo "zedge: loaded ${SERVICE_TARGET} via launchctl load" >&2
    JUST_BOOTSTRAPPED=1
    return 0
  fi
  return 1
}

bootstrap_service() {
  bootout_all
  # launchd needs a moment after bootout before the same plist can bootstrap again.
  sleep 2

  ERR_FILE="$(mktemp)"
  ATTEMPT=1
  MAX_ATTEMPTS=5

  # Prefer gui (console session); fall back to user (works more reliably from
  # some terminals / macOS versions).
  for DOMAIN_TRY in "gui/${UID_VALUE}" "user/${UID_VALUE}"; do
    ATTEMPT=1
    while [ "${ATTEMPT}" -le "${MAX_ATTEMPTS}" ]; do
      if launchctl bootstrap "${DOMAIN_TRY}" "${PLIST_PATH}" 2>"${ERR_FILE}"; then
        DOMAIN="${DOMAIN_TRY}"
        SERVICE_TARGET="${DOMAIN}/${LABEL}"
        persist_domain "${DOMAIN}"
        launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
        rm -f "${ERR_FILE}"
        echo "zedge: loaded ${SERVICE_TARGET}" >&2
        JUST_BOOTSTRAPPED=1
        return 0
      fi
      # Already loaded?
      if launchctl print "${DOMAIN_TRY}/${LABEL}" >/dev/null 2>&1; then
        DOMAIN="${DOMAIN_TRY}"
        SERVICE_TARGET="${DOMAIN}/${LABEL}"
        persist_domain "${DOMAIN}"
        launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
        rm -f "${ERR_FILE}"
        echo "zedge: already loaded ${SERVICE_TARGET}" >&2
        return 0
      fi
      ATTEMPT=$((ATTEMPT + 1))
      sleep 1
    done
  done

  echo "zedge: launchctl bootstrap failed (tried gui and user domains):" >&2
  cat "${ERR_FILE}" >&2 || true
  rm -f "${ERR_FILE}"

  if bootstrap_service_legacy_load; then
    return 0
  fi

  echo "zedge: launchctl load fallback also failed. If you previously ran stop/kill with an older script, run: launchctl print gui/${UID_VALUE}/${LABEL}" >&2
  return 1
}

ensure_loaded() {
  resolve_service_target || true
  if [ -f "${PLIST_PATH}" ] && launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
    return 0
  fi
  if [ ! -f "${PLIST_PATH}" ]; then
    echo "zedge: missing launch agent plist at ${PLIST_PATH}; run install first." >&2
    return 1
  fi
  bootstrap_service
}

# Kill any process still listening on TCP port (supervisor/manual gnode).
kill_tcp_listener_port() {
  port="${1:-7331}"
  pids=$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "${pids}" ]; then
    echo "zedge: nothing listening on TCP ${port}"
    return 0
  fi
  echo "zedge: stopping listener PIDs on :${port}: ${pids}"
  for pid in ${pids}; do
    kill "${pid}" 2>/dev/null || true
  done
  sleep 2
  pids=$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "${pids}" ]; then
    echo "zedge: SIGKILL remaining on :${port}: ${pids}"
    for pid in ${pids}; do
      kill -9 "${pid}" 2>/dev/null || true
    done
  fi
}

kill_moonshine_listeners() {
  kill_tcp_listener_port 8080
  kill_tcp_listener_port 8000
}

kill_stale_companion_entrypoints() {
  pids=$(ps -axo pid=,command= | awk -v self="$$" '
    $1 != self &&
    /open-source\/zedge\/companion\/src\/(index|companion-supervisor)\.ts/ {
      print $1
    }
  ' || true)
  if [ -z "${pids}" ]; then
    return 0
  fi

  echo "zedge: stopping stale companion process PIDs: ${pids}"
  for pid in ${pids}; do
    kill "${pid}" 2>/dev/null || true
  done
  sleep 2

  pids=$(ps -axo pid=,command= | awk -v self="$$" '
    $1 != self &&
    /open-source\/zedge\/companion\/src\/(index|companion-supervisor)\.ts/ {
      print $1
    }
  ' || true)
  if [ -n "${pids}" ]; then
    echo "zedge: SIGKILL stale companion process PIDs: ${pids}"
    for pid in ${pids}; do
      kill -9 "${pid}" 2>/dev/null || true
    done
  fi
}

print_status() {
  resolve_service_target || true
  STATUS_FILE="$(mktemp)"
  if launchctl print "${SERVICE_TARGET}" >"${STATUS_FILE}" 2>&1; then
    sed -n '1,120p' "${STATUS_FILE}"
  else
    echo "zedge: launch agent is not loaded (${SERVICE_TARGET})."
    echo "Try: pnpm run zedge:launch-agent:install"
    sed -n '1,20p' "${STATUS_FILE}" || true
  fi
  rm -f "${STATUS_FILE}"
  echo
  echo "zed api key launch environment:"
  zed_api_key="$(launchctl getenv ZEDGE_API_KEY 2>/dev/null || true)"
  if [ -n "${zed_api_key}" ]; then
    if [ "${zed_api_key}" = "${LOCAL_ZED_API_KEY}" ]; then
      echo "ZEDGE_API_KEY=${LOCAL_ZED_API_KEY} (local placeholder)"
    else
      echo "ZEDGE_API_KEY is set by the user"
    fi
  else
    echo "ZEDGE_API_KEY is not set"
  fi
  if [ -f "${ENV_PLIST_PATH}" ]; then
    echo "persistent env helper: ${ENV_PLIST_PATH}"
  else
    echo "persistent env helper: missing"
  fi
  echo
  echo "listener:"
  lsof -iTCP:7331 -sTCP:LISTEN -n -P 2>/dev/null || true
  echo
  echo "health:"
  curl -sS -m 5 "http://127.0.0.1:7331/health" || true
  echo
  echo "ready:"
  curl -sS -m 5 "http://127.0.0.1:7331/probe/ready" || true
  echo
}

wait_for_health() {
  attempts="${1:-120}"
  attempt=1
  while [ "${attempt}" -le "${attempts}" ]; do
    if curl -fsS -m 5 "http://127.0.0.1:7331/probe/ready" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "zedge: companion did not become route-ready after ${attempts}s" >&2
  return 1
}

sync_zed_settings() {
  curl -fsS -m 10 -X POST "http://127.0.0.1:7331/zed/settings/sync" >/dev/null 2>&1 || true
}

seed_zed_keychain() {
  if ! command -v security >/dev/null 2>&1; then
    return 0
  fi
  security add-internet-password \
    -a Bearer \
    -s "http://127.0.0.1:7331/v1" \
    -w "${LOCAL_ZED_API_KEY}" \
    -U >/dev/null 2>&1 || true
}

case "${ACTION}" in
  install)
    ensure_zed_env_loaded
    write_plist
    bootstrap_service
    wait_for_health || true
    seed_zed_keychain
    sync_zed_settings
    print_status
    ;;
  uninstall)
    bootout_all
    bootout_zed_env_agent
    unset_zed_openai_compatible_env_if_placeholder
    launchctl unload -w "${PLIST_PATH}" >/dev/null 2>&1 || true
    rm -f "${DOMAIN_STATE}"
    rm -f "${PLIST_PATH}"
    rm -f "${ENV_PLIST_PATH}"
    echo "zedge: removed ${PLIST_PATH}"
    echo "zedge: removed ${ENV_PLIST_PATH}"
    ;;
  start)
    ensure_zed_env_loaded
    ensure_loaded
    resolve_service_target || true
    if [ "${JUST_BOOTSTRAPPED}" != "1" ]; then
      launchctl kickstart -k "${SERVICE_TARGET}"
    fi
    wait_for_health || true
    seed_zed_keychain
    sync_zed_settings
    print_status
    ;;
  stop)
    bootout_all
    rm -f "${DOMAIN_STATE}"
    echo "zedge: stopped launch agent (gui and user domains)"
    ;;
  kill)
    bootout_all
    rm -f "${DOMAIN_STATE}"
    kill_stale_companion_entrypoints
    kill_moonshine_listeners
    kill_tcp_listener_port 7331
    echo "zedge: companion listener on :7331 stopped."
    ;;
  restart)
    bootout_all
    rm -f "${DOMAIN_STATE}"
    kill_stale_companion_entrypoints
    kill_moonshine_listeners
    kill_tcp_listener_port 7331
    sleep 2
    if [ -f "${PLIST_PATH}" ]; then
      ensure_zed_env_loaded
      write_plist
      bootstrap_service
      wait_for_health || true
      seed_zed_keychain
      sync_zed_settings
      print_status
    else
      echo "zedge: no launch agent at ${PLIST_PATH} — nothing to relaunch. Install with: pnpm run zedge:launch-agent:install"
      echo "zedge: or start the supervisor manually once the port is free."
    fi
    ;;
  status)
    print_status
    ;;
  logs)
    echo "stdout: ${OUT_LOG}"
    tail -n 120 "${OUT_LOG}" 2>/dev/null || true
    echo
    echo "stderr: ${ERR_LOG}"
    tail -n 120 "${ERR_LOG}" 2>/dev/null || true
    ;;
  *)
    usage
    exit 64
    ;;
esac

#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: companion-launch-agent.sh <install|uninstall|start|stop|restart|status|logs>

Commands:
  install    Create + load the launch agent and start the zedge companion.
  uninstall  Stop + unload the launch agent and remove the plist.
  start      Start the launch agent job immediately.
  stop       Stop the launch agent job immediately.
  restart    Restart the launch agent job immediately.
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
COMPANION_DIR="${WORKSPACE_ROOT}/open-source/zedge/companion"

LABEL="ai.forkjoin.zedge.sidecar"
UID_VALUE="$(id -u)"
DOMAIN="gui/${UID_VALUE}"
SERVICE_TARGET="${DOMAIN}/${LABEL}"
LAUNCH_AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENT_DIR}/${LABEL}.plist"
OUT_LOG="/tmp/zedge-sidecar-launchd.out.log"
ERR_LOG="/tmp/zedge-sidecar-launchd.err.log"

write_plist() {
  mkdir -p "${LAUNCH_AGENT_DIR}"
  cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd ${COMPANION_DIR} &amp;&amp; pnpm run start</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${COMPANION_DIR}</string>

  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF
}

bootstrap_service() {
  launchctl bootout "${SERVICE_TARGET}" >/dev/null 2>&1 || true

  ERR_FILE="$(mktemp)"
  ATTEMPT=1
  MAX_ATTEMPTS=5
  while [ "${ATTEMPT}" -le "${MAX_ATTEMPTS}" ]; do
    if launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}" 2>"${ERR_FILE}"; then
      launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${SERVICE_TARGET}" >/dev/null 2>&1 || true
      rm -f "${ERR_FILE}"
      return 0
    fi
    if launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
      launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${SERVICE_TARGET}" >/dev/null 2>&1 || true
      rm -f "${ERR_FILE}"
      return 0
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done

  echo "zedge: launchctl bootstrap failed after ${MAX_ATTEMPTS} attempts:" >&2
  cat "${ERR_FILE}" >&2 || true
  rm -f "${ERR_FILE}"
  return 1
}

ensure_loaded() {
  if launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
    return 0
  fi
  if [ ! -f "${PLIST_PATH}" ]; then
    echo "zedge: missing launch agent plist at ${PLIST_PATH}; run install first." >&2
    return 1
  fi
  launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}"
  launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
}

print_status() {
  STATUS_FILE="$(mktemp)"
  if launchctl print "${SERVICE_TARGET}" >"${STATUS_FILE}" 2>&1; then
    sed -n '1,120p' "${STATUS_FILE}"
  else
    echo "zedge: launch agent is not loaded (${SERVICE_TARGET})."
    sed -n '1,20p' "${STATUS_FILE}" || true
  fi
  rm -f "${STATUS_FILE}"
  echo
  echo "listener:"
  lsof -iTCP:7331 -sTCP:LISTEN -n -P || true
  echo
  echo "health:"
  curl -sS -m 5 "http://127.0.0.1:7331/health" || true
  echo
}

case "${ACTION}" in
  install)
    write_plist
    bootstrap_service
    sleep 2
    print_status
    ;;
  uninstall)
    launchctl bootout "${SERVICE_TARGET}" >/dev/null 2>&1 || true
    launchctl disable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
    rm -f "${PLIST_PATH}"
    echo "zedge: removed ${PLIST_PATH}"
    ;;
  start)
    ensure_loaded
    launchctl kickstart -k "${SERVICE_TARGET}"
    print_status
    ;;
  stop)
    launchctl bootout "${SERVICE_TARGET}" >/dev/null 2>&1 || true
    echo "zedge: stopped ${SERVICE_TARGET}"
    ;;
  restart)
    ensure_loaded
    launchctl kickstart -k "${SERVICE_TARGET}"
    sleep 1
    print_status
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

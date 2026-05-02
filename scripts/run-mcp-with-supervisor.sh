#!/bin/sh
# Ensure the companion sidecar answers on /probe/ready before starting the MCP stdio
# bridge. Zed's Agent panel uses openai_compatible HTTP to 127.0.0.1:7331 directly;
# it does not go through this process, so also consider companion-launch-agent.sh
# install for a login-time listener.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)
RUN_TS="${SCRIPT_DIR}/run-ts-entry.sh"
PORT="${ZEDGE_COMPANION_PORT:-7331}"
HEALTH_URL="http://127.0.0.1:${PORT}/probe/ready"
LOG_FILE="${HOME}/.edgework/zedge-supervisor.log"

if ! command -v curl >/dev/null 2>&1; then
  echo "zedge: curl is required for run-mcp-with-supervisor.sh" >&2
  exit 127
fi

mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true

if ! curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
  echo "[zedge] Companion not route-ready; starting supervisor (log: ${LOG_FILE})" >&2
  ( cd "${WORKSPACE_ROOT}" && nohup env AEON_ROOT="${WORKSPACE_ROOT}" /bin/sh "${RUN_TS}" \
      "open-source/zedge/companion/src/companion-supervisor.ts" \
      >>"${LOG_FILE}" 2>&1 & )
  deadline=$(( $(date +%s) + 120 ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
      echo "[zedge] Companion is route-ready" >&2
      break
    fi
    sleep 0.5
  done
  if ! curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "zedge: companion did not become route-ready at ${HEALTH_URL} (see ${LOG_FILE})" >&2
    exit 1
  fi
fi

exec /bin/sh "${RUN_TS}" "open-source/zedge/companion/src/mcp-stdio.ts"

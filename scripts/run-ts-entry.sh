#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <entry.ts> [args...]" >&2
  exit 64
fi

ENTRY_PATH="$1"
shift

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)

resolve_node_runtime() {
  if [ -n "${ZEDGE_NODE_RUNTIME:-}" ]; then
    if [ -x "${ZEDGE_NODE_RUNTIME}" ]; then
      printf '%s\n' "${ZEDGE_NODE_RUNTIME}"
      return 0
    fi

    if command -v "${ZEDGE_NODE_RUNTIME}" >/dev/null 2>&1; then
      command -v "${ZEDGE_NODE_RUNTIME}"
      return 0
    fi

    echo "zedge: ZEDGE_NODE_RUNTIME is not executable: ${ZEDGE_NODE_RUNTIME}" >&2
    exit 127
  fi

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "zedge: could not find Node. Install Node or set ZEDGE_NODE_RUNTIME." >&2
  exit 127
}

resolve_tsx_loader() {
  if [ -n "${ZEDGE_TSX_LOADER:-}" ] && [ -f "${ZEDGE_TSX_LOADER}" ]; then
    printf '%s\n' "${ZEDGE_TSX_LOADER}"
    return 0
  fi

  for candidate in \
    "${WORKSPACE_ROOT}/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs" \
    "${WORKSPACE_ROOT}/node_modules/tsx/dist/loader.mjs"; do
    if [ -f "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "zedge: could not find tsx loader. Install dependencies or set ZEDGE_TSX_LOADER." >&2
  exit 127
}

exec_gnode_bridge() {
  NODE_RUNTIME="$(resolve_node_runtime)"
  TSX_LOADER="$(resolve_tsx_loader)"
  exec "${NODE_RUNTIME}" \
    --import "${TSX_LOADER}" \
    "${WORKSPACE_ROOT}/open-source/gnosis/gnode/bridge-driver.ts" \
    run "${ENTRY_PATH}" --export main "$@"
}

if [ "${ENTRY_PATH#/}" = "${ENTRY_PATH}" ]; then
  ABS_ENTRY_PATH="${WORKSPACE_ROOT}/${ENTRY_PATH}"
else
  ABS_ENTRY_PATH="${ENTRY_PATH}"
fi

: "${GNODE_FORCE_TSX:=1}"
export GNODE_FORCE_TSX

case "${ABS_ENTRY_PATH}" in
  "${WORKSPACE_ROOT}/open-source/zedge/companion/src/index.ts")
    exec_gnode_bridge "$@"
    ;;
  "${WORKSPACE_ROOT}/open-source/zedge/companion/src/mcp-stdio.ts")
    exec_gnode_bridge "$@"
    ;;
  "${WORKSPACE_ROOT}/open-source/zedge/companion/src/companion-supervisor.ts"|\
  "${WORKSPACE_ROOT}/open-source/zedge/companion/src/gnosis-lsp.ts")
    exec_gnode_bridge "$@"
    ;;
esac

NODE_RUNTIME="$(resolve_node_runtime)"
exec "${NODE_RUNTIME}" "${WORKSPACE_ROOT}/open-source/gnosis/bin/gnode.js" run "${ENTRY_PATH}" "$@"

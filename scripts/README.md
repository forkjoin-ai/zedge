# zedge scripts

Parent: [Zedge](../README.md)

## Scope

Small operator-facing scripts that support local Zedge setup and launch behavior.

## Files

- `generate-settings.ts` fetches the live Zedge model catalog when it can, then prints a Zed provider settings snippet plus the local companion start hint. The companion snippet also exposes `wasm-local` for explicit local Aether selection.
- `run-ts-entry.sh` is the repo-local TypeScript entrypoint launcher used by the extension. It now routes the companion, supervisor, MCP bridge, and other TypeScript entrypoints through the checked-in `gnode` runtime instead of special-casing the companion shell onto Bun.

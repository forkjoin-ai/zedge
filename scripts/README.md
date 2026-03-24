# zedge scripts

Parent: [Zedge](../README.md)

## Scope

Small operator-facing scripts that support local Zedge setup and launch behavior.

## Files

- `generate-settings.ts` prints a Zed provider settings snippet plus the local companion start hint. The remote snippet stays on the coordinator-backed models, while the companion snippet also exposes `wasm-local` for explicit local Aether selection.
- `run-ts-entry.sh` is the repo-local TypeScript entrypoint launcher used by the extension. It now defaults to the checked-in `gnode` runtime for generic TypeScript entrypoints and only falls back to Bun for the Bun-only companion shell (`companion/src/index.ts`).

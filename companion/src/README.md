# zedge companion src

Parent: [Companion Sidecar](../README.md)

Child: [Tests](./__tests__/README.md)

## Scope

Runtime entrypoints, HTTP server surfaces, Babelfish routes, and the sidecar-only bridges that back the Zed extension.

## Highlights

- `index.ts` boots the local companion service, mesh, forge, VFS, collaboration, kernel, capacitor, CRDT, and UCAN bridges.
- `companion-supervisor.ts` is the manual launcher that owns `index.ts`, polls `/health`, and applies the guarded restart policy outside the companion process itself.
- `server.ts` now includes the local companion PID plus the host runtime in `/health`, which gives operators and the end-to-end tests a precise way to verify both restarts and the `gnode` launch path.
- `config.ts` reads `~/.edgework/zedge.json` and honors `ZEDGE_COMPANION_PORT` plus `ZEDGE_LISTENER_MODE` overrides so tests and local launches can isolate the companion without mutating user config; the companion now derives its mesh discovery UDP port from the companion port unless `listener.discoveryPort` is set explicitly.
- `config.ts` now defaults `preferredModel` to `wasm-local`, so unconfigured companion chat, selftest, and resilient streaming surfaces start local-first.
- `p2p-mesh.ts` now binds discovery sockets with `reuseAddr`, uses the derived discovery UDP port, and treats occupied discovery ports as non-fatal so isolated local runs do not present a mesh bind collision as a companion startup failure.
- `model-catalog.ts` is the shared model metadata source that drives live Zed settings regeneration, the companion catalog fallback, and the settings generator output.
- `zed-settings.ts` rewrites the local `openai_compatible.Zedge.available_models` block from the live companion model IDs so the Zed picker updates on companion load.
- `companion-activity.ts` records when the owned companion sidecar is intentionally busy with local WASM warmup or generation so the parent watchdogs can distinguish "busy" from "dead".
- `companion-restart-policy.ts` centralizes the bounded restart thresholds so the manual supervisor and the MCP bridge make the same restart decisions, including skipping health-driven restarts while the child has marked itself busy with local inference work.
- `mcp-stdio.ts` exposes the MCP stdio bridge that Zed launches as the context-server process, including the prompt catalog that mirrors the extension slash commands for Zed Agent and the guarded supervisor that polls companion health and performs bounded auto-restarts for the owned sidecar process.
- `auth.ts` now uses device authorization and background polling instead of a localhost OAuth callback server.
- `feedback-log.ts` owns the append-only local feedback log that backs `GET/POST /feedback`.
- `runtime-command.ts` centralizes how the companion turns a TypeScript entrypoint into an actual process command, routing the companion, MCP bridge, supervisor, and LSP entrypoints through the checked-in `run-ts-entry.sh` wrapper so they all launch through `gnode`.
- `forge-bridge.ts` owns local project discovery and deploy/process control for the companion HTTP surface.
- `gnot-bridge.ts` gives the companion a first-class `open-source/gnot` surface for workspace file discovery, `.gnot` lint/format authoring checks, and deploy-shell `doctor` / `next` / `status` diagnostics through both HTTP and MCP.
- `aether-local-runtime.ts` centralizes the verified local TinyLlama chat and MiniLM embedding fallback that `inference-bridge.ts` uses when mesh, edge, and Cloud Run paths miss, and exposes the local chat load state for health reporting.
- `inference-bridge.ts` owns the tier race, exposes the `wasm-local` model in the companion catalog, gives the local Aether runtime a real final fallback window before the echo belt-and-suspenders path, and now pre-warms the chat model while marking long local work so supervisors do not kill a healthy-but-busy child during first-load warmup.
- `server.ts` mounts the OpenAI-compatible, Babelfish, workspace, mesh, and admin routes onto an `x-gnosis` host and can expose that host either directly or behind a native `gnosis-uring` public listener.
- `__tests__/server-route-audit.test.ts` keeps the inline `server.ts` route table honest by parsing the route inventory, smoke-testing the cold-start contracts, and checking the `zedgeControlSurface` request translation without needing a live sidecar process.

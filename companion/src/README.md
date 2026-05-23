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
- `config.ts` reads Zed's Zedge provider settings as the model source of truth, then falls back to `gnosis-local` when local companion config is absent or still names a retired Edgework model.
- `p2p-mesh.ts` now binds discovery sockets with `reuseAddr`, uses the derived discovery UDP port, and treats occupied discovery ports as non-fatal so isolated local runs do not present a mesh bind collision as a companion startup failure.
- `model-catalog.ts` is the shared Moonshine model metadata source that drives live Zed settings regeneration, the companion catalog fallback, and the settings generator output.
- `zed-settings.ts` rewrites the local `openai_compatible.Zedge.available_models` block and stale Zedge default model from the live companion model IDs so the Zed picker updates on companion load.
- `companion-activity.ts` records when the owned companion sidecar is intentionally busy with local WASM warmup or generation so the parent watchdogs can distinguish "busy" from "dead".
- `companion-restart-policy.ts` centralizes the bounded restart thresholds so the manual supervisor and the MCP bridge make the same restart decisions, including skipping health-driven restarts while the child has marked itself busy with local inference work.
- `mcp-stdio.ts` exposes the MCP stdio bridge that Zed launches as the context-server process, including the prompt catalog that mirrors the extension slash commands for Zed Agent and the guarded supervisor that polls companion health and performs bounded auto-restarts for the owned sidecar process.
- `local-mcp.ts` shares the companion-local MCP registry with HTTP and agentic callers, including cached preflight for tool definitions.
- `agentic-orchestrator.ts` runs the companion-owned tool loop with local MCP tools while calling Moonshine with `X-Zedge-Agentic: off` as a bare text generator.
- `edit-preview.ts` owns preview-first range/search replacement tokens with workspace path validation, old-content hashes, expiry, and single-use apply status.
- `auth.ts` now uses device authorization and background polling instead of a localhost OAuth callback server.
- `feedback-log.ts` owns the append-only local feedback log that backs `GET/POST /feedback`.
- `runtime-command.ts` centralizes how the companion turns a TypeScript entrypoint into an actual process command, routing the companion, MCP bridge, supervisor, and LSP entrypoints through the checked-in `run-ts-entry.sh` wrapper so they all launch through `gnode`.
- `forge-bridge.ts` owns local project discovery and deploy/process control for the companion HTTP surface.
- `gnot-bridge.ts` gives the companion a first-class `open-source/gnot` surface for workspace file discovery, `.gnot` lint/format authoring checks, and deploy-shell `doctor` / `next` / `status` diagnostics through both HTTP and MCP.
- `babelfish.ts`, `babelfish-routes.ts`, and `babelfish-mcp.ts` expose `.gnarly` compile, fastest-preview, and source-to-Gnarly generation flows on the same preview-first Babelfish path as code translation.
- `aether-local-runtime.ts` centralizes the verified local TinyLlama chat and MiniLM embedding fallback that `inference-bridge.ts` uses when mesh, edge, and Cloud Run paths miss, and exposes the local chat load state for health reporting.
- `inference-bridge.ts` owns the `infer()` tier chain (`forkjoin` passthrough to the OWN distributed-inference mesh as primary, Moonshine as fallback, echo as the final belt-and-suspenders response), refreshes the live `/v1/models` catalog on demand, and reports the tier used on `X-Zedge-Tier`. See the parent README "Inference Tiers" section for the `ZEDGE_FORKJOIN_*` config.
- `prefill-window.ts` owns the explicit speculative prefill window proxy surface, maps `X-Zedge-Prefill-Window` to Moonshine's attach header, and remaps `X-Moonshine-Prefill-*` telemetry back to `X-Zedge-Prefill-*`.
- `tts-relay.ts` owns the companion-side `GET /tts/status`, `GET /tts/voices`, `POST /tts/config`, `POST /tts/speak`, and `POST /tts/preview` paths that fetch WAV/PCM from Moonshine, write a temporary host file, and dispatch `afplay`, `aplay`, `paplay`, or file-only output based on `ZEDGE_TTS_AUDIO_MODE`; `ZEDGE_TTS_ENABLED=0` disables playback without touching chat.
- `server.ts` mounts the OpenAI-compatible, local MCP, edit-preview, prefill-window, TTS, Babelfish, workspace, mesh, and admin routes onto an `x-gnosis` host and can expose that host either directly or behind a native `gnosis-uring` public listener.
- `__tests__/server-route-audit.test.ts` keeps the inline `server.ts` route table honest by parsing the route inventory, smoke-testing the cold-start contracts, and checking the `zedgeControlSurface` request translation without needing a live sidecar process.

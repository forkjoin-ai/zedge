# @affectively/zedge-companion

Parent: [Zedge](../README.md)

Child: [Source](./src/README.md)

`@affectively/zedge-companion` is the local sidecar service behind Zedge.

The fair brag is that it is more than a thin proxy. It handles inference routing, local coordination, and the service layer that the Zed extension talks to on `localhost:7331`.

The HTTP shell now rides on `x-gnosis`, and the default public listener path is a native `gnosis-uring` proxy in front of a loopback-only x-gnosis app shell. The companion API no longer carries its own standalone Node server loop or the old localhost OAuth callback server, and the checked-in launcher now runs the companion through `gnode` instead of a Bun-only shell.

For local inference, the companion now routes its on-device fallback through Aether prompt/runtime helpers: the verified TinyLlama chat path stays local-first for `wasm-local`, that selectable model now ships as the default `preferredModel`, and local embedding fallback upgrades from pure hash vectors to a MiniLM model path when the cache is available.

The companion also now syncs the `language_models.openai_compatible.Zedge.available_models` block in local Zed settings from the live model catalog at startup, so model picker entries track current edge and local availability instead of drifting behind a hardcoded snippet.

## What It Helps You Do

- run the local Zedge companion service
- expose an OpenAI-compatible inference endpoint to Zed
- provide the MCP entry point and other sidecar behaviors
- mirror the extension slash-command catalog into Zed Agent via MCP prompts and the generic `zedge_command` tool
- store local response-quality feedback through the companion so extension and Agent surfaces can submit to the same log
- serve the Babelfish capability matrix and preview/apply translation endpoints
- surface Babelfish MCP tools and non-mutating LSP affordances

## Babelfish Endpoints

The companion now owns the Babelfish contract used by the extension, MCP, and LSP:

- `GET /babelfish/capabilities`
- `POST /babelfish/code/preview`
- `POST /babelfish/code/apply`
- `POST /babelfish/text/translate`
- `POST /babelfish/explain`

The companion returns capability tiers from the Gnosis registry, not a hand-maintained language list in the extension. Preview responses carry the token required for any later apply step.
Those preview tokens are single-use and mode-bound: only `rewrite_in_place_requested` previews can later apply an in-place rewrite, while `generate_files` writes immediately and does not leave a reusable mutation token behind.

## Babelfish Settings

`~/.edgework/zedge.json` now supports a `babelfish` section:

```json
{
  "babelfish": {
    "enabled": true,
    "ambientSuggestions": true,
    "defaultHumanLanguage": "en",
    "requirePreviewForInPlaceRewrite": true
  }
}
```

The same config file also controls the public listener mode:

```json
{
  "listener": {
    "mode": "gnosis-uring-proxy",
    "threads": 1,
    "useUring": false
  }
}
```

`mode: "bun"` keeps the direct x-gnosis listener shape for backward compatibility. `mode: "gnosis-uring-proxy"` starts a loopback x-gnosis app shell and exposes the public port through the native Rust listener instead.

For hermetic local runs and integration tests, environment overrides take precedence over the file config: `ZEDGE_COMPANION_PORT` forces the public companion port and `ZEDGE_LISTENER_MODE` forces either `bun` or `gnosis-uring-proxy` without editing `~/.edgework/zedge.json`. The mesh discovery UDP port now derives from the companion port by default, so isolated sidecars do not all contend for `7332`; set `listener.discoveryPort` only when you need a non-derived shared discovery port.

## Auth Flow

`POST /auth/login` now starts OAuth device authorization instead of opening a local callback port. The response returns the verification URL and user code immediately, while the companion polls in the background and `GET /auth/whoami` reflects the eventual authenticated state.

## Local Feedback

The companion now owns a local feedback route for Zedge response-quality notes:

- `GET /feedback?n=20`
- `POST /feedback`

Entries are stored locally in `.edgework/feedback.jsonl`, so the Zed extension and Zed Agent prompt/tool surfaces can write to the same append-only feedback log without any paid external service.

## Local-First Constraint

Babelfish is intentionally local/self-hosted at the companion layer. The sidecar uses the local Gnosis polyglot pipeline, local state, and local preview/apply logic. It does not introduce Workers AI or new paid remote dependencies as a fallback.

## Commands

```bash
open-source/zedge/scripts/run-ts-entry.sh open-source/zedge/companion/src/index.ts
open-source/zedge/scripts/run-ts-entry.sh open-source/zedge/companion/src/companion-supervisor.ts
open-source/zedge/scripts/run-ts-entry.sh open-source/zedge/companion/src/mcp-stdio.ts
```

The extension itself launches these entrypoints through the checked-in
`open-source/zedge/scripts/run-ts-entry.sh` wrapper so Zed does not depend on a
bare `node` binary being on PATH.

`companion-supervisor.ts` is the manual launcher path for the same bounded
health polling behavior: it owns the raw `index.ts` child, waits through
startup grace, requires repeated health failures before restarting,
rate-limits restart storms, and restarts immediately when its owned child exits
unexpectedly. The companion `/health` payload now includes the owned child PID,
so live diagnostics can prove that a restart actually happened. `mcp-stdio.ts` uses the same restart policy when Zed launches the
context server bridge.

## Why This README Exists

The companion is a real package with its own runtime role, so it should have its own entry point in the docs.

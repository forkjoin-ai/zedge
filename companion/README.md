# @affectively/zedge-companion

Parent: [Zedge](../README.md)

Child: [Source](./src/README.md)

`@affectively/zedge-companion` is the local sidecar service behind Zedge.

The fair brag is that it is more than a thin proxy. It handles inference routing, local coordination, and the service layer that the Zed extension talks to on `localhost:7331`.

**First-time setup:** use the parent [Zedge README](../README.md#if-you-only-read-one-thing) (`pnpm run zedge:launch-agent:install` once on macOS), or in Zed run **`/edge-setup`** — do not rely on starting the supervisor by hand every session.

The HTTP shell now rides on `x-gnosis`, and the default public listener path is a native `gnosis-uring` proxy in front of a loopback-only x-gnosis app shell. The companion API no longer carries its own standalone Node server loop or the old localhost OAuth callback server, and the checked-in launcher now runs the companion through `gnode` instead of a Bun-only shell.

For local inference, the companion now routes chat through the Moonshine OpenAI-compatible container on `127.0.0.1:8080`. The selectable fallback model is `gnosis-local`, with `tinyllama-1.1b` matching the checked-in Docker Compose default when that service reports its live catalog.

The default chat path is deliberately fast and bare: companion `/v1/chat/completions` proxies to Moonshine with `X-Zedge-Agentic: off`. Requests that opt in with `X-Zedge-Agentic: tools|auto|1|true` or OpenAI tool body fields run the companion-owned agentic loop instead. That loop preflights local MCP tools from the companion cache, calls Moonshine only as a text generator, and forces the recursive Moonshine call back to bare mode.

The companion also now syncs the `language_models.openai_compatible.Zedge.available_models` block in local Zed settings after the Moonshine startup probe, so model picker entries track the live container instead of drifting behind a hardcoded Edgework snippet.

Local speech playback uses `POST /tts/speak` as a host relay: the companion
calls Moonshine's local `POST /v1/audio/speech` endpoint, writes the returned
WAV to a temp file, and on macOS plays it with `afplay`. Linux can use `aplay`
when ALSA is available, and `ZEDGE_TTS_AUDIO_MODE=file` keeps the generated WAV
without attempting playback. `ZEDGE_TTS_ENABLED=0` disables the relay without
touching the OpenAI-compatible chat path.
`POST /tts/preview` returns the generated file without playback, and
`GET /tts/voices` exposes the voice IDs used by the companion MCP tools.

## What It Helps You Do

- run the local Zedge companion service
- expose an OpenAI-compatible inference endpoint to Zed
- provide the MCP entry point and other sidecar behaviors
- own the agentic tool loop, local tool preflight cache, and preview-first edit
  application surface
- relay local Moonshine TTS output to the host audio device without touching
  the OpenAI chat/SSE path
- mirror the extension slash-command catalog into Zed Agent via MCP prompts and the generic `zedge_command` tool
- expose a dedicated `zedge_gnot` MCP tool plus `zedge-gnot` slash-command backing for `open-source/gnot` file discovery, authoring checks, and deploy-shell diagnostics
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

## Agentic And Tool Endpoints

The companion exposes local agent tooling without making Moonshine pay the MCP
startup cost:

- `POST /mcp`
- `GET /tools/preflight`
- `POST /edit/range/preview`
- `POST /edit/range/apply`

Edit previews carry an old-content hash, expiry, and single-use apply state.
MCP tools such as `zedge_apply_code` and `zedge_preview_range_replace` return
preview IDs first; `zedge_apply_edit_preview` is the only write step.

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

## Local TTS Audio

Docker Desktop on macOS does not expose CoreAudio as `/dev/snd`, so the default
path is host relay rather than device passthrough. Start Moonshine with the
portable compose file and leave `MOONSHINE_TTS_AUDIO_MODE=host` or unset it:

```bash
docker compose -f docker-compose.moonshine.yml up openai-compat
```

Then call the companion relay:

```bash
curl http://127.0.0.1:7331/tts/status

curl -X POST http://127.0.0.1:7331/tts/config \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"mode":"host"}'

curl -X POST http://127.0.0.1:7331/tts/speak \
  -H 'Content-Type: application/json' \
  -d '{"input":"hello from moonshine"}'

curl http://127.0.0.1:7331/tts/voices

curl -X POST http://127.0.0.1:7331/tts/preview \
  -H 'Content-Type: application/json' \
  -d '{"input":"render but do not play"}'
```

Inside Zed, use `/edge-tts status`, `/edge-tts enable`, `/edge-tts disable`,
`/edge-tts host`, `/edge-tts file`, `/edge-tts pulse`, `/edge-tts alsa`,
`/edge-tts auto`, or `/edge-tts speak <text>`.

Native Linux Docker hosts can opt into ALSA passthrough:

```bash
docker compose -f docker-compose.moonshine.yml -f docker-compose.audio-linux.yml up openai-compat
```

PulseAudio/TCP is supported with `MOONSHINE_TTS_AUDIO_MODE=pulse` plus a host
`PULSE_SERVER=tcp:host.docker.internal:4713` setup, but it is intentionally not
the default because the host relay is simpler on macOS.

## Local-First Constraint

Babelfish is intentionally local/self-hosted at the companion layer. The sidecar uses the local Gnosis polyglot pipeline, local state, and local preview/apply logic. It does not introduce Workers AI or new paid remote dependencies as a fallback.

## Gnot Surface

The companion now carries a first-class `gnot` bridge for the local monorepo:

- `GET /gnot/files`
- `POST /gnot/command`

Supported `action` values are `files`, `lint`, `format`, `doctor`, `next`, and
`status`. The same operations are available to Agent through the dedicated
`zedge_gnot` MCP tool and the mirrored `/zedge-gnot` slash command.

## Commands

From repo root (macOS launch agent):

```bash
pnpm run zedge:launch-agent:install
pnpm run zedge:launch-agent:status
pnpm run zedge:launch-agent:logs
pnpm run zedge:launch-agent:restart
pnpm run zedge:launch-agent:uninstall
```

From `open-source/zedge/companion`:

```bash
pnpm run launch-agent:install
pnpm run launch-agent:status
pnpm run launch-agent:logs
pnpm run launch-agent:restart
pnpm run launch-agent:uninstall
```

Manual entrypoint launchers:

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

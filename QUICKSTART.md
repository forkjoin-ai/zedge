# Zedge Quickstart

Parent: [Zedge](./README.md)

Get the Zedge companion sidecar running on **port 7331** and wired into [Zed](https://zed.dev) fast. Every command below already exists in the root `package.json` (`zedge:*` scripts) or in `open-source/zedge/scripts/`. Run them from the **monorepo root** (next to the root `package.json`) unless noted.

## 1. One-time setup (macOS)

Install the launch agent. It registers a KeepAlive job so the sidecar survives reboots — you never start it by hand.

```bash
pnpm run zedge:launch-agent:install
```

This also:
- Auto-configures Zed `settings.json` (`api_url` + model catalog) at `~/.config/zed/settings.json`.
- Stores the placeholder API key `zedge-local` in the macOS Keychain / `ZEDGE_API_KEY` (Zed ignores `settings.json` `api_key` for `openai_compatible` providers).
- Defaults Moonshine to `deepseek-r1-1.5b` using the cached knot at `~/.edgework/models/deepseek-r1-1.5b.knot` (offline, no R2 fetch). Override with `ZEDGE_MOONSHINE_MODEL`.

Lost inside Zed? Run the slash command **`/edge-setup`** for the same steps, copy-paste friendly.

## 2. Run

The launch agent keeps the sidecar alive automatically. To control it:

```bash
pnpm run zedge:launch-agent:status     # launchctl + :7331 listener state
pnpm run zedge:restart                 # kill + relaunch (needs prior install)
pnpm run zedge:kill                    # stop launch agent + free :7331
pnpm run zedge:launch-agent:logs       # tail stdout/stderr
pnpm run zedge:launch-agent:uninstall  # unload + remove plist
```

**Not on macOS** (no launchd) — keep one terminal open with the supervisor in the foreground:

```bash
pnpm run gnode -- run open-source/zedge/companion/src/companion-supervisor.ts --export main
```

Or via Nx (foreground, TS source):

```bash
pnpm run a0 -- run edge-ai:dev
```

## 3. Verify

```bash
pnpm run zedge:doctor          # diagnose Moonshine / disk / :7331 / :8080 / :8000
pnpm run zedge:doctor -- --fix # diagnose + repair the stack + smoke-test "hello"
```

Or directly: `curl -fsS http://127.0.0.1:7331/probe/ready`.

To switch coding models from Zed, run `/edge-model use <model-id>` after the
model appears in `/edge-model status`. `codestral-22b` is served through the
`gnosis-openai-mesh` Cloud Run lane when the live Edgework catalog advertises it.

In Zed, the Agent panel should list the Zedge models. If it still says **No API key**, run `pnpm run zedge:restart` then `pnpm run zedge:doctor`. Note: `localhost` vs `127.0.0.1` matters for Zed on macOS — the companion rewrites `localhost:7331` to `127.0.0.1` in your Zed settings on first model sync.

## Build the stable launchd artifacts

The launch agent runs a bundled supervisor from `companion/dist/`. Rebuild it after changing companion source:

```bash
pnpm run a0 -- run edge-ai:build:companion   # builds open-source/zedge/companion/dist/
```

Equivalent per-project targets:

```bash
pnpm run a0 -- run @affectively/zedge-companion:build   # dist/companion(-supervisor).mjs + import map
pnpm run a0 -- run @affectively/zedge-companion:start    # build then run dist/companion-supervisor.mjs
pnpm run a0 -- run @affectively/zedge-companion:mcp       # run the MCP stdio server (src/mcp-stdio.ts)
pnpm run a0 -- run @affectively/zedge-companion:typecheck
```

## Build the Zed extension (Rust → WASM)

```bash
pnpm run zedge:build:extension   # cargo build --release --target wasm32-wasip1
```

The prebuilt `extension.wasm` is checked in, so this is only needed when you change the Rust extension in `open-source/zedge/src/`.

## Map: scripts → what they do

| Command | Effect |
| --- | --- |
| `pnpm run zedge:launch-agent:install` | Register + start the KeepAlive sidecar (macOS) |
| `pnpm run zedge:restart` / `zedge:kill` | Relaunch / stop the sidecar + free `:7331` |
| `pnpm run zedge:doctor [-- --fix]` | Health check / repair the inference stack |
| `pnpm run a0 -- run edge-ai:build:companion` | Bundle the launchd-stable supervisor into `dist/` |
| `pnpm run a0 -- run edge-ai:dev` / `edge-ai:start` | Run the supervisor (TS source / bundled dist) |
| `pnpm run zedge:build:extension` | Build the Rust/WASM Zed extension |

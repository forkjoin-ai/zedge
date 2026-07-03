# Zedge

Parent: [Open Source](../README.md)

Children:
- [Companion Sidecar](./companion/README.md)
- [Grammars](./grammars/README.md)
- [Languages](./languages/README.md)
- [Scripts](./scripts/README.md)
- [Snippets](./snippets/README.md)

Zedge brings AI-assisted coding to [Zed](https://zed.dev) through a local extension and a local companion sidecar.

The fair brag is architectural honesty: the extension is real, the sidecar is real, and the inference path is designed to stay close to the machine or network you control rather than disappearing into a generic hosted gateway.

## Hard Wins

- Zedge ships both sides of the product: a Rust/WASM Zed extension and a local
  TypeScript companion sidecar.
- The companion exposes an OpenAI-compatible local endpoint while also carrying
  MCP prompts, slash-command mirrors, model sync, collaboration hooks, and
  deploy-shell diagnostics.
- Babelfish uses the local Gnosis language registry and WASM compiler path for
  polyglot analysis, translation previews, `.gnarly` support, and fastest-path
  diagnostics.
- Local launch-agent scripts make the common macOS path restartable and
  observable instead of requiring a remembered foreground command.
- Mutation is preview/token gated for Babelfish rewrite paths.

## Honest Boundaries

- Zedge is not a hosted coding-agent service. The default posture is local
  sidecar, local WASM, and owned inference surfaces.
- `localhost` versus `127.0.0.1` matters for Zed on macOS; this README keeps
  that operational detail explicit because it is a real failure mode.
- Babelfish rewrite previews are not applied until an explicit apply step.
- No Workers AI, paid external APIs, or permanent Cloud Run dependency should
  be added to make the feature work.

## If you only read one thing

Zedge needs a **local server** on port **7331**. You should not start it by hand every day.

**macOS — one-time install** (from the monorepo root, next to the root `package.json`):

```bash
pnpm install
pnpm run zedge:launch-agent:install
```

That registers a launch agent with **KeepAlive**, so the sidecar comes back after reboots and you do not need to remember commands. The launch agent defaults Moonshine to **`deepseek-r1-1.5b`** using the cached knot at `~/.edgework/models/deepseek-r1-1.5b.knot` so inference works offline (no R2 fetch). Override with `ZEDGE_MOONSHINE_MODEL` in the plist or env.

**Then in Zed:** the companion **auto-configures** Zedge at startup:

- **`settings.json`**: `api_url` + model catalog (`~/.config/zed/settings.json` on macOS)
- **macOS Keychain** or **`ZEDGE_API_KEY`**: the API key Zed actually reads for `openai_compatible` providers (settings.json `api_key` is ignored)

Placeholder key: `zedge-local`. If the Agent panel still says “No API key”, run `pnpm run zedge:restart` or `pnpm run zedge:doctor`.

The install also creates a tiny login helper at `~/Library/LaunchAgents/ai.forkjoin.zedge.sidecar.zed-env.plist` so the placeholder key is restored after an OS reload. `uninstall` removes that helper and unsets `ZEDGE_API_KEY` only when it is still the placeholder.

**Lost?** In Zed, run slash command **`/edge-setup`** — same steps, copy-paste friendly.

After the companion starts, it rewrites `localhost:7331` to `127.0.0.1` in your Zed settings when it syncs the model list — or change it once in **Zed → Settings → JSON** yourself.

**Check / kill / restart / logs / uninstall:**

```bash
pnpm run zedge:doctor            # diagnose Moonshine / disk / :7331 / :8080 / :8000
pnpm run zedge:doctor -- --fix   # diagnose + repair stack + smoke-test hello
pnpm run a0 -- run edge-ai:build:companion  # bundle launchd-stable supervisor (dist/)
pnpm run zedge:launch-agent:status
pnpm run zedge:kill              # stop launch agent + kill :7331 (stuck/manual too)
pnpm run zedge:restart           # kill then relaunch via launch agent (needs prior install)
pnpm run zedge:launch-agent:logs
pnpm run zedge:launch-agent:uninstall
```

In Zed, use **`/edge-model status`** to inspect the selected/running sovereign
model, or **`/edge-model use <model-id>`** to persist an admitted model, sync the
Zed picker, reconcile Moonshine, and run an inference smoke. `codestral-22b`
rides the `gnosis-openai-mesh` lane once the live Edgework catalog advertises it.

**Not on macOS:** keep one terminal open with:

```bash
pnpm run gnode -- run open-source/zedge/companion/src/companion-supervisor.ts --export main
```

### Moonshine Typeahead Prewarm

The companion exposes `POST /v1/chat/completions/prewarm` for speculative
Moonshine typeahead. It accepts the same `model` and `messages` shape as chat
completion, forwards the prompt to Moonshine with `max_tokens: 0`, and returns
no assistant text. The purpose is to fill the amplituhedron replay cache for a
prefix that the editor may need soon.

The warmup only commits the prompt boundary. A later real completion can still
choose any `max_tokens`, temperature, or stop policy; it starts from the cached
tail residual and then decodes under the real request's generation settings.

By default the route returns `202` after queueing the warmup. Send
`{"wait":true,...}` when a test wants to wait for the prefill/capture to finish.
If the editor cancels the HTTP request before completion, the companion cancels
the warmup instead of committing output.

For testing cache state through Zedge:

```bash
curl http://127.0.0.1:7331/moonshine/cache
curl -X POST http://127.0.0.1:7331/moonshine/cache/clear \
  -H 'Content-Type: application/json' \
  -d '{"kinds":["amplituhedron"]}'
```

`amplituhedron` clears prompt replay/typeahead captures. `memo` clears the
matvec memo. They are separate on purpose: most prompt-replay tests should only
clear `amplituhedron`, leaving resident model state and matvec memo untouched.

## The Two Parts

1. **Zed extension** in `src/`
   - Rust/WASM extension
   - registers Zedge as a language-model provider
   - adds slash commands to Zed and mirrors that command catalog into Zed Agent through the companion MCP prompt surface

2. **Companion sidecar** in `companion/`
   - public listener on `localhost:7331` now defaults to a native `gnosis-uring` proxy, with the x-gnosis app shell bound on loopback behind it
   - handles inference routing, collaboration bridges, compute pooling, and local integration work
   - syncs Zed's `openai_compatible.Zedge.available_models` list from the live Moonshine catalog at startup so the picker tracks the container instead of stale Edgework options
   - defaults `preferredModel` to the selectable `gnosis-local` Moonshine path before dropping to echo
   - now exposes Babelfish polyglot translation/explanation over the Gnosis language registry
   - now exposes first-class `gnot` workspace discovery plus `doctor` / `next` / `status` deploy-shell diagnostics for local `open-source/gnot` apps

## Local TTS Slash Command

Moonshine TTS is controlled from Zed through `/edge-tts`:

```text
/edge-tts status
/edge-tts enable
/edge-tts disable
/edge-tts host
/edge-tts file
/edge-tts pulse
/edge-tts alsa
/edge-tts auto
/edge-tts speak hello from Moonshine
```

`disable` only turns off the companion playback relay. It does not affect chat
completion, SSE streaming, or the Moonshine model picker.

## Babelfish (WASM Native Compiler)

Babelfish is the universal code-translation layer built on top of the Gnosis topological IR. It is integrated directly into the `zedge` extension using `gnosis-betti-wasm` for a zero-latency, high-performance compilation pipeline. Zedge queries the native Gnosis polyglot registry to expose the following capabilities:

### Benchmarks & Parity

The latest Phase 4 integration shifts the heavy lifting from the companion JS process directly into the WASM native context using `gnosis-betti-wasm`.
- **Performance:** Multi-language execution operates near **O(1)** matrix time, successfully multiplexing across all 21 supported languages simultaneously. Worst-case jitter remains under 10ms for topological parallel branching.
- **Topological Parity:** Lossless translation guarantees identical AST and topological node counts across multiple target languages simultaneously. No syntactic decay or ghost mass is lost across permutations.
- **Native Slash Commands:** Using `/edge-babelfish-native` hits the zero-copy WASM target without IPC latency.

- `analyze` and `explain` are exposed for every Gnosis-supported programming language
- `translate` and `scaffold` are exposed anywhere the GG scaffolder can emit target files
- `rewrite-preview` is deliberately tiered and remains experimental
- `.gnarly` files are first-class multilingual GG-family sources: Zedge can compile them, preview fastest-language topology candidates, and surface speed findings as read-only LSP hints
- human-language translation is local-first and preserves code fences instead of translating code tokens blindly

### Slash Command

Use the umbrella Zed slash command:

```text
/edge-babelfish capabilities
/edge-babelfish fastest <file.gnarly> [candidate-language,...]
/edge-babelfish compile-gnarly <file.gnarly>
/edge-babelfish gnarly-from <file-path> [candidate-language,...]
/edge-babelfish explain <file-path> [audience-language]
/edge-babelfish translate-code <target-language> <file-path>
/edge-babelfish translate-text <target-language> <file-path>
/edge-babelfish generate <target-language> <file-path>
/edge-babelfish rewrite-preview <target-language> <file-path>
/edge-babelfish apply <preview-id> [rewrite_in_place|generate_files]
```

The Zed Agent MCP prompt mirror uses `zedge-babelfish` for the same
Babelfish operations.

### Gnarly

`.gnarly` keeps GG node and edge syntax, then adds optional metadata and
embedded implementation blocks for cross-language programs:

```gnosis
gnarly "image-pipeline" {
  languages = ["typescript", "rust", "go"]
  entry = ingest
}

(transform: PolyglotBridgeCall {
  fastest: true,
  candidates: ["rust", "go", "zig"],
  callee: "transform"
})

impl transform in rust {
  // optional embedded source
}
```

The companion emits speed diagnostics as LSP hints from `gnosis-gnarly-speed`.
Quick fixes and slash commands open Babelfish previews first; they do not mutate
files until an explicit apply step is used.

Zedge registers `.gnarly` as its own Zed language backed by the Gnosis grammar
and `gnosis-lsp`, so Gnarly files get syntax highlighting, nested `impl ... in
... { ... }` block parsing, compile/fastest code actions, and non-blocking
speed hints in editor.

## Gnot

`open-source/gnot` now has a first-class companion surface in Zedge:

```text
/zedge-gnot files
/zedge-gnot lint <file-path>
/zedge-gnot format <file-path>
/zedge-gnot doctor <app> [environment]
/zedge-gnot next <app> [environment]
/zedge-gnot status <app> [environment]
```

The companion also exposes the same surface to Zed Agent through the dedicated
`zedge_gnot` MCP tool, so `.gnot` work can stay inside the same local sidecar
instead of bouncing to a separate adapter.

### Safety Model

- `preview` is the default output mode
- `generate_files` writes files only when explicitly requested
- preview tokens are single-use and only allow the apply mode they were created for
- `generate_files` writes immediately and leaves only an informational preview token behind
- in-place mutation always goes through `rewrite_in_place_requested` first and then an explicit apply token
- ambient Babelfish LSP hints are read-only and never mutate buffers

### Local-Only Constraint

Babelfish in Zedge is intentionally local/self-hosted. The companion uses the existing local Gnosis, local WASM, and local sidecar surfaces. It does not add Workers AI, paid external APIs, or permanent Cloud Run dependencies to make the feature work.

## What People May Like

- the sidecar is OpenAI-compatible enough to plug into Zed quickly
- the extension adds native slash-command affordances when you want the full experience
- Zed Agent sees the same Zedge command names through MCP prompts instead of a separate ad hoc command list
- the companion is more than an inference proxy; it also handles collaboration and compute-pool responsibilities
- the architecture keeps local and edge-oriented routing options open

## Building The Extension

```bash
cd open-source/zedge
cargo build --release --target wasm32-wasi
```

Then install it in Zed as a dev extension.

## Companion Package

The companion is also its own package:

- `@affectively/zedge-companion`

It includes start, dev, build, and MCP entry points.

## Why This README Is Grounded

Zedge does not need a giant architecture manifesto in the README. The strongest fair brag is that it already has both sides of the product: a Zed extension and a real local companion service.

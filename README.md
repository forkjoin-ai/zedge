# Zedge

Parent: [Open Source](../README.md)

Child: [Companion Sidecar](./companion/README.md)

Zedge brings AI-assisted coding to [Zed](https://zed.dev) through a local extension and a local companion sidecar.

The fair brag is architectural honesty: the extension is real, the sidecar is real, and the inference path is designed to stay close to the machine or network you control rather than disappearing into a generic hosted gateway.

## The Two Parts

1. **Zed extension** in `src/`
   - Rust/WASM extension
   - registers Zedge as a language-model provider
   - adds slash commands to Zed

2. **Companion sidecar** in `companion/`
   - Bun HTTP server on `localhost:7331`
   - handles inference routing, collaboration bridges, compute pooling, and local integration work
   - now exposes Babelfish polyglot translation/explanation over the Gnosis language registry

## Babelfish

Babelfish is the code-translation layer over the exact Gnosis polyglot registry. Zedge now asks Gnosis for the supported programming languages and publishes the resulting capability matrix through the companion instead of hardcoding the list in the extension.

- `analyze` and `explain` are exposed for every Gnosis-supported programming language
- `translate` and `scaffold` are exposed anywhere the GG scaffolder can emit target files
- `rewrite-preview` is deliberately tiered and remains experimental
- human-language translation is local-first and preserves code fences instead of translating code tokens blindly

### Slash Command

Use the umbrella slash command:

```text
/zedge-babelfish capabilities
/zedge-babelfish explain <file-path> [audience-language]
/zedge-babelfish translate-code <target-language> <file-path>
/zedge-babelfish translate-text <target-language> <file-path>
/zedge-babelfish generate <target-language> <file-path>
/zedge-babelfish rewrite-preview <target-language> <file-path>
/zedge-babelfish apply <preview-id> [rewrite_in_place|generate_files]
```

### Safety Model

- `preview` is the default output mode
- `generate_files` writes files only when explicitly requested
- preview tokens are single-use and only allow the apply mode they were created for
- `generate_files` writes immediately and leaves only an informational preview token behind
- in-place mutation always goes through `rewrite_in_place_requested` first and then an explicit apply token
- ambient Babelfish LSP hints are read-only and never mutate buffers

### Local-Only Constraint

Babelfish in Zedge is intentionally local/self-hosted. The companion uses the existing local Gnosis, local WASM, and local sidecar surfaces. It does not add Workers AI, paid external APIs, or permanent Cloud Run dependencies to make the feature work.

## Fast Path

The quickest way to try Zedge is to run only the companion and point Zed's OpenAI-compatible provider settings at it.

### Start the companion

```bash
pnpm install
pnpm gnode run open-source/zedge/companion/src/index.ts
```

### Then point Zed at:

- `http://localhost:7331/v1`

That gives you a working local provider path without compiling the extension first.

## What People May Like

- the sidecar is OpenAI-compatible enough to plug into Zed quickly
- the extension adds native slash-command affordances when you want the full experience
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

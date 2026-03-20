# Zedge

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

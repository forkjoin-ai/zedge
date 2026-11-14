# Qwen3.5 4B uncensored in zedge

Status: first-class local catalog lane, forkjoin request wiring landed.
Last updated: 2026-11-14.

## Audit

- `companion/src/aether-local-runtime.ts` is the Transformers.js TinyLlama WASM
  fallback, not the qwen35 Aether runtime.
- qwen-family local models run through the fat-station/Moonshine sidecar in
  `companion/src/moonshine-docker.ts`.
- `inference-bridge.ts` already has the Forkjoin OpenAI-compatible lane, which
  streams SSE and is the correct carrier for qwen35.

## Wiring landed

- `qwen35-4b-uncensored` is registered in `LOCAL_MOONSHINE_MODELS` with:
  - local knot `~/.edgework/models/qwen35-4b-uncensored-q4km.knot`
  - R2 dense-knot fallback
  - `tokenizerGgufUrl` so fat-station downloads the exact Qwen3.5 tokenizer
  - no fallback to the shared Qwen2 tokenizer
- Catalog entry: `maxTokens: 512`, `forkjoinTier: true`, adult gate.
- Forkjoin requests now forward:
  - `tools`
  - `tool_choice`
  - `disable_thinking`
  - `thinking_budget_mode`
  - `think_budget`

## Evidence

```text
PASS zedge forkjoin request body > forwards qwen35 tools and think steering
PASS zedge forkjoin request body > omits absent steering fields
```

Live puppet streaming (same OpenAI shape zedge emits):

```text
delta "One,"
delta " two"
delta ", th"
...
10 model-time deltas; tool call ping -> arguments "{}"
```

## Open gaps

- The qwen35 tokenizer URL boot path has not been exercised through
  `startLocalMoonshine` end-to-end on a machine with the 2.7 GB knot.
- zedge's local sidecar does not implement the browser Aether runtime's native
  tool loop; it relies on the forkjoin/puppet lane for native tool calls.
- Full companion typecheck/build is blocked by unrelated shared-tree failures in
  `open-source/x-gnosis` and a stalled `broadcast-dashboard:build` graph.

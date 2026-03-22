# @affectively/zedge-companion

Parent: [Zedge](../README.md)

`@affectively/zedge-companion` is the local sidecar service behind Zedge.

The fair brag is that it is more than a thin proxy. It handles inference routing, local coordination, and the service layer that the Zed extension talks to on `localhost:7331`.

## What It Helps You Do

- run the local Zedge companion service
- expose an OpenAI-compatible inference endpoint to Zed
- provide the MCP entry point and other sidecar behaviors
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

## Local-First Constraint

Babelfish is intentionally local/self-hosted at the companion layer. The sidecar uses the local Gnosis polyglot pipeline, local state, and local preview/apply logic. It does not introduce Workers AI or new paid remote dependencies as a fallback.

## Commands

```bash
pnpm run gnode -- run open-source/zedge/companion/src/index.ts
pnpm run gnode -- run open-source/zedge/companion/src/mcp-stdio.ts
```

## Why This README Exists

The companion is a real package with its own runtime role, so it should have its own entry point in the docs.

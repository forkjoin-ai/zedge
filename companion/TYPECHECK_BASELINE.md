# Zedge Companion Typecheck Baseline

Snapshot date: 2026-05-23
Captured by: ZW2 (zedge first-class distributed-inference passthrough wave)

This is the authoritative typecheck baseline for `@affectively/zedge-companion`.
The sibling's `forkjoin` passthrough feature work (PRIMARY inference tier in
`companion/src/inference-bridge.ts`) must NOT increase the total error count
recorded here. Use this file to judge that diff.

## Command

Run from the repository root (`/Users/buley/Documents/Code/emotions`). The
typecheck config's `baseUrl` is `../../..`, so the resolver expects repo root as
the working directory:

```bash
pnpm exec tsc -p open-source/zedge/companion/tsconfig.typecheck.json --noEmit
```

This is the exact command wired into `open-source/zedge/project.json` ->
`targets.typecheck`. Equivalent nx surface: `a0 typecheck edge-ai` (project name
is `edge-ai`).

Note: the per-package script `companion/package.json` -> `typecheck`
(`tsc --noEmit`) is NOT the authoritative invocation -- it lacks the project
config and resolves a different include/baseUrl. Use the `-p ...typecheck.json`
form above for the baseline.

## Toolchain at capture time

- TypeScript: 5.9.3 (resolved via `node_modules/.pnpm/typescript@5.9.3`)
- Node: v25.8.0
- esbuild: 0.27.7
- `pnpm install` is reported broken repo-wide (bun:test deps). No reinstall was
  attempted. The typecheck ran successfully against the already-resolved
  `node_modules` -- it did NOT fail to run.

## Total error count

74 errors.

The typecheck DID run to completion; the 74 figure is a real, reproducible
error count, not a "could not run" placeholder.

## Where the errors live (critical)

Only 1 of the 74 errors is in zedge companion source. The other 73 come from
the `@a0n/x-gnosis` workspace package, which the companion's tsconfig pulls in
through path mappings (`@a0n/x-gnosis` -> `open-source/x-gnosis/src/*`). Because
`tsconfig.typecheck.json` sets `rootDir: ../../..` and the resolver follows the
imports, x-gnosis source is type-checked transitively.

| Source area                         | Errors |
| ----------------------------------- | ------ |
| open-source/x-gnosis/src/**         | 73     |
| open-source/zedge/companion/src/**  | 1      |
| TOTAL                               | 74     |

## Per error-code breakdown (all 74)

| Code   | Count | Kind                                                  |
| ------ | ----- | ----------------------------------------------------- |
| TS7006 | 48    | Parameter implicitly has an 'any' type                |
| TS7008 | 25    | Member implicitly has an 'any' type                   |
| TS2307 | 1     | Cannot find module / missing type declarations        |

## Per-file breakdown (all 74)

| File                                                       | Errors |
| ---------------------------------------------------------- | ------ |
| open-source/x-gnosis/src/gg-site-runtime.ts                | 19     |
| open-source/x-gnosis/src/runtime-io-substrate.ts           | 16     |
| open-source/x-gnosis/src/runtime-attestation.ts            | 12     |
| open-source/x-gnosis/src/server.ts                         | 8      |
| open-source/x-gnosis/src/tauri-edge-runtime.ts             | 5      |
| open-source/x-gnosis/src/runtime-continuation-client.ts    | 3      |
| open-source/x-gnosis/src/handlers/registry.ts              | 3      |
| open-source/x-gnosis/src/aeon-control.ts                   | 3      |
| open-source/x-gnosis/src/bridge-vfs-content-source.ts      | 2      |
| open-source/x-gnosis/src/federation-supernode.ts           | 1      |
| open-source/x-gnosis/src/aeon-object.ts                    | 1      |
| open-source/zedge/companion/src/babelfish-lsp.ts           | 1      |

## The single zedge-companion error

```
open-source/zedge/companion/src/babelfish-lsp.ts(1,53): error TS2307:
  Cannot find module 'vscode-languageserver' or its corresponding type
  declarations.
```

This is a missing optional dependency (`vscode-languageserver`) in the resolved
`node_modules`, not a logic/type error introduced by source. It is part of the
baseline and should remain at exactly 1 companion-source error unless that dep
is added.

## How to judge the forkjoin passthrough diff against this baseline

- Authoritative metric: total error count from the command above must stay <= 74.
- Stricter, more honest metric: companion-source errors
  (`open-source/zedge/companion/src/**`) must stay <= 1. The 73 x-gnosis errors
  are pre-existing dependency noise unrelated to the forkjoin work; the sibling
  cannot fix them and should not be charged for them, but should also not let
  the companion-source count grow.
- To isolate companion-source errors:

  ```bash
  pnpm exec tsc -p open-source/zedge/companion/tsconfig.typecheck.json --noEmit \
    2>&1 | grep "error TS" | grep "open-source/zedge/companion/" | wc -l
  ```

## Build status (esbuild bundle)

Authoritative build commands:

- `open-source/zedge/project.json` -> `build:companion`
- `companion/package.json` -> `build`

```bash
pnpm exec esbuild open-source/zedge/companion/src/index.ts --bundle \
  --outdir=open-source/zedge/companion/dist --platform=node --format=esm \
  --minify --packages=external
```

Result at capture time: the bundle FAILS, but the blocker is a pre-existing
syntax error in a transitive dependency, NOT in zedge companion source:

```
[ERROR] Expected ")" but found ":"
  open-source/neural/packages/engine/src/buleyean/engine.ts:75:14
    75 | if (!typed: unknown) {
```

This file is reachable through the bundle graph (the companion depends on
`@a0n/buleyean-kernel`). The defect is upstream of zedge and outside this wave's
scope; flag for the lead. The forkjoin passthrough work does not need to fix it,
but the companion bundle cannot be green until that neural-engine syntax error
is repaired. Mark "esbuild bundle green" as: to confirm once the upstream
neural defect is fixed.

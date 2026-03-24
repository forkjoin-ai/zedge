# zedge companion src/__tests__

Parent: [Companion Source](../README.md)

## Scope

Focused sidecar tests for MCP tooling, Babelfish behavior, runtime-command resolution, deploy helpers, and local bridge surfaces.

## Highlights

- `slash-command-e2e.test.ts` boots an isolated companion process on a temporary port and verifies that live `zedge-models` and `zedge-selftest wasm-local-only-test` slash-command calls succeed through the MCP `zedge_command` tool.
- `mcp-babysitter.test.ts` verifies the shared companion restart policy that both the manual supervisor and the MCP bridge use for startup grace, busy-child suppression, repeated health failures, forced child-exit restarts, and restart-storm throttling.
- `companion-activity.test.ts` verifies the on-disk busy marker that lets the parent watchdogs distinguish the owned sidecar's long local WASM warmup/generation windows from an actual dead child.
- `runtime-command.test.ts` verifies the Bun-first TypeScript entrypoint command builder and the explicit Node fallback shape.
- `babelfish-mcp.test.ts` verifies the MCP bridge tool list and Babelfish proxying behavior.
- `mcp-prompts.test.ts` verifies that the MCP prompt list stays aligned with `extension.toml`, that the Rust dispatch table matches the same command set, and that file-backed or quoted-argument command execution resolves correctly.
- `forge-bridge.test.ts` verifies local project discovery, deploy state, process tracking, and log/event surfaces.
- `inference-bridge.test.ts` verifies the merged model list plus the local Aether-backed chat and embedding fallback surfaces.
- `vfs-bridge.test.ts` verifies workspace-tree and change tracking behavior for the local VFS bridge.

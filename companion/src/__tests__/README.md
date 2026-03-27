# zedge companion src/__tests__

Parent: [Companion Source](../README.md)

## Scope

Focused sidecar tests for MCP tooling, Babelfish behavior, runtime-command resolution, deploy helpers, and local bridge surfaces.

## Highlights

- `server-route-audit.test.ts` parses the inline route inventory from `server.ts`, fails if any endpoint lacks either a smoke case or an explicit skip, and exercises the `handleWebRequest` plus `zedgeControlSurface` paths with fast mocked dependencies so router drift is caught before the full sidecar boots.
- `p2p-mesh-bind.test.ts` starts two short-lived child processes against the same isolated companion port and verifies that both bind the derived mesh discovery UDP port without `EADDRINUSE`, so hermetic runs can coexist with each other instead of contending on the default discovery socket.
- `slash-command-e2e.test.ts` boots an isolated companion process through the checked-in launcher, verifies the live companion reports `runtime.hostRuntime: "gnode"`, and then verifies that `zedge-models` plus `zedge-selftest wasm-local-only-test` succeed through the MCP `zedge_command` tool.
- `companion-supervisor.e2e.test.ts` boots the `gnode`-managed supervisor on an isolated port, kills the owned companion child, and verifies that health returns on a fresh child PID while the restarted child still reports `runtime.hostRuntime: "gnode"`.
- `mcp-babysitter.test.ts` verifies the shared companion restart policy that both the manual supervisor and the MCP bridge use for startup grace, busy-child suppression, repeated health failures, forced child-exit restarts, and restart-storm throttling.
- `companion-activity.test.ts` verifies the on-disk busy marker that lets the parent watchdogs distinguish the owned sidecar's long local WASM warmup/generation windows from an actual dead child.
- `runtime-command.test.ts` verifies the wrapper-backed TypeScript entrypoint command builder used for the `gnode` launch path.
- `babelfish-mcp.test.ts` verifies the MCP bridge tool list and Babelfish proxying behavior.
- `mcp-prompts.test.ts` verifies that the MCP prompt list stays aligned with `extension.toml`, that the Rust dispatch table matches the same command set, and that file-backed or quoted-argument command execution resolves correctly.
- `forge-bridge.test.ts` verifies local project discovery, deploy state, process tracking, and log/event surfaces.
- `inference-bridge.test.ts` verifies the merged model list plus the local Aether-backed chat and embedding fallback surfaces.
- `aether-local-runtime.test.ts` locks the local TinyLlama prompt formatting that keeps the WASM fallback producing usable English instead of echo-like near-misses.
- `vfs-bridge.test.ts` verifies workspace-tree and change tracking behavior for the local VFS bridge.

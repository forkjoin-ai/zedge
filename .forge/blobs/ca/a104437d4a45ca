# Remove the launcher dependency on tsx

The running companion is launched by `run-ts-entry.sh` with a direct tsx
preload. The launch-agent source fallback repeats that path. Gnode also uses
tsx for hosted MCP source even when its driver was built by ggbuild.

Route Zedge's source launcher through Monster and gnode, preserving explicit
Node selection, absolute source identity, service `main` invocation and forwarded
arguments. Route the launchd source fallback through the same gnode authority;
launchd retains its real Node executable because of its Documents-path boundary.
Remove forced tsx configuration. Gnode owns the shared ggbuild driver and the
existing TypeScript compiler hook for source modules. TypeScript transformation
is not a semantic typecheck receipt.

The launcher selects the companion's tsconfig through `GNODE_TSCONFIG_PATH`.
Its `paths` mappings are required at runtime: package exports can point at absent
dist artifacts while the declared mapping points at the source implementation.
The compiler host parses the configuration and resolves those mappings with
TypeScript; declaration files alone do not supply executable implementations.

Qualify shell routing and arguments, actual compiler-hosted module execution,
MCP initialize/tools/list, nonzero exits and process cleanup before restarting
the existing companion or MCP connections. Preserve browser/debugger work and
its outstanding gates. Do not remove the workspace dependency while unrelated
legacy callers still exist.

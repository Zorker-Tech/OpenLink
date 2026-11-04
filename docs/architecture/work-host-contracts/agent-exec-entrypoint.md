# Agent execution entrypoint contract

`packages/agent-exec/index.ts` is the public entrypoint for operation resources served by the execution daemon. Each
operation keeps its implementation in a focused module and owns a distinct resource symbol; the entrypoint exposes the
supported operations as one discoverable surface.

The conflict-notice module has overlapping helper names, so its public exports are listed explicitly. Remote and
controlled execution adapters own message construction and transport conversion; the package entrypoint exposes the
resource boundary used by callers.

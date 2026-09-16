# Box exec

The Box/remote execution bridge contract.

A Box is an isolated environment (VM/container/remote host) with a service boundary rather than
a shell escape hatch. The bridge exposes authenticated exec, file transfer and MCP routing,
validates workspace roots, and reports readiness per Box.

Each Box needs: generation identity, auth token scope, timeout and cancellation propagation,
file transfer size/type policy, and an explicit recreate/migrate path when the environment is
replaced.

# Durable goal metrics

Each continuation start increments `agent.goal.continuation.started` once. When a goal leaves active status, the host
increments `agent.goal.terminal_transition` and records the total continuation count in
`agent.goal.continuations_at_terminal`. Both terminal measurements share `status` and `reason` labels, while the start
counter has no per-goal identifiers or labels. All measurements use the request context's metrics backend.

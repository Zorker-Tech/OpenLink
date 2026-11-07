# Workspace Grep Executor Contract

Workspace search is a Slate executor operation. `source/packages/agent-exec/grep.ts` owns the request
filters, output variants and result metadata; generated search messages are converted only in
`adapters/interop/agent/grep-operation-adapter.ts`.

Requests carry the query, optional root and file pattern, output mode, context range, case handling, file
type, result limit, sorting, call identity, sandbox policy and offset. Count, file-list and content results
have separate variants. Each retains total counts, result truncation, search truncation and any applied
limit or offset. Results may be grouped by workspace and may include a separate active-editor result.

Tests cover all three output forms, nested file matches, context-line flags, missing and unknown result
cases, optional filters, sandbox policy and both executor paths.

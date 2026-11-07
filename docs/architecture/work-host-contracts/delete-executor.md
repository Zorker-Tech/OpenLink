# Workspace Delete Executor Contract

Deletion is a Slate application operation. `source/packages/agent-exec/delete.ts` owns the path and
call identity request and the result union consumed by Work-host features.

The result records the deleted path, exact file size and prior content on success. It preserves distinct
outcomes for a missing path, a non-file path, a read-only or permission denial, a busy file, a policy
rejection, an execution error and an unset response.

Generated request and result messages are converted only in
`adapters/interop/agent/delete-operation-adapter.ts`. The read-only executor wrapper returns Slate's
permission-denied result directly, and tests cover every conversion and both remote and controlled
execution.

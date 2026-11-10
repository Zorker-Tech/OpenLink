# Directory Listing Executor Contract

Directory listing is a Slate application operation. `source/packages/agent-exec/ls.ts` owns its request,
result variants and recursive directory-tree data. Local traversal and Work-host callers consume this
contract directly.

## Request and results

`LsExecutorArgs` carries a workspace path, optional ignore patterns, call id, sandbox policy and timeout.
An absent sandbox policy remains absent; a supplied policy is translated at the message boundary.

The result distinguishes a completed tree, a timed-out partial tree, an execution error, a policy
rejection and an unset result. The tree retains each path, processed flag, child directories, file names,
terminal metadata, omitted-file count and extension counts. Timeout responses keep any partial tree so a
caller can still use the data that was gathered before the deadline.

## Ownership and transport

`LocalLsExecutor` constructs Slate directory-tree records directly. The interop adapter converts those
records only when crossing the retained generated execution frame. The local-execution daemon's
versioned operation format remains a separately versioned Slate wire contract.

The behavior tests cover traversal ordering, ignore policy, sandbox propagation, character-budget
accounting, timeout partial results, distinct path failures, terminal metadata round-trips and both
resource execution paths.

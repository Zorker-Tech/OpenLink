# Shell Stream Executor Contract

Shell execution requests and the events that describe a running command are Slate application data. The executor resource
uses `ShellStreamExecutorArgs` and `ShellStreamExecutorEvent` from `source/packages/agent-exec/shell-stream-operation.ts`.
The local executor emits the same event model; callers do not consume generated message classes.

The request retains the command, working directory, call and conversation identities, timeout policy, sandbox request,
approval context, output capture threshold, stdin behavior, classifier context and progress-notification configuration.
Optional fields stay absent when the caller did not supply them. Timeout behavior defaults to foreground execution.

The event stream preserves its order and every outcome: start, stdout, stderr, exit, rejection, permission denial,
unsupported sandbox, background handoff, hook context and an unset event. Exit events retain the exit code, abort state,
reason, elapsed time and output-file metadata. Unknown abort and background reason codes remain explicit unknown values
with their original numeric code.

Generated executor frames are translated only in `adapters/interop/agent/shell-stream-exec-adapter.ts`. The local-exec
daemon dispatches the Slate event values directly; its own versioned JSON protocol remains the process boundary. The
agent tool still serializes its stored tool-call record through its adapter, separately from the executor request.

`tests/packages/interop-shell-stream-exec-adapter.test.ts` pins request and event conversion, remote and controlled
execution paths, and event order. `tests/packages/interop-local-shell-stream-executor-adapter.test.ts` pins the full
event projection, hook contexts and unknown enum preservation. The shell-tool and local-exec suites pin user-visible
results, approval behavior, background handoff, cancellation and directory fallback.

# Shell Executor Contract

Foreground command execution is represented by `ShellExecutorArgs` and `ShellExecResponse` in
`source/packages/agent-exec/shell.ts`. The request owns the command, working directory, parser summary, sandbox policy,
timeout behavior, approval state, output capture settings and call identity. Parser data is kept separate from the
command text so a host can record exactly what its parser determined.

The response uses `outcome.kind` for success, failure, timeout, rejection, spawn error, permission denial and an
unrecognized outcome. Completed commands retain stdout, stderr, exit code, signal, execution duration, output-file
metadata, truncation details and background-shell identity. Abort and background reasons use Slate values and preserve
unknown numeric codes. Response-level sandbox, background and terminal-folder metadata remain separate from the
command outcome.

Generated executor frames are converted only in `adapters/interop/agent/shell-operation-adapter.ts`. Host-originated
box commands are constructed directly as Slate requests in `host/boxes/box-shell-command.ts`; box transfer, window,
browser, computer-use and recording services consume the Slate response. The model-facing tool-call record continues
through its own transcript adapter.

`tests/packages/interop-shell-operation-adapter.test.ts` covers bidirectional request conversion and round-trips each
response case, timing and output-file metadata, background details and unknown enum values. Host consumer tests pin
retry classification, read-only refusal, box-window decisions, browser execution, file transfer and recording cleanup.

Foreground-to-background handoff is a separate resource with `ShellControlArgs` and `ShellControlResult` in
`source/packages/agent-exec/shell-control.ts`. It names the target by tool-call id, distinguishes accepted, not-found
and unrecognized statuses, and carries an optional Slate shell result. The control adapter preserves unknown status
codes and the accepted command's output metadata.

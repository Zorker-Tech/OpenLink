# Background Shell Executor Contract

Starting a durable shell and writing to its input are Slate executor operations. Their request/result
types live in `source/packages/agent-exec/background-shell.ts`; local shell behavior returns the same
first-party result model.

Spawn requests retain command, working directory, call identity, sandbox policy, approval context,
notification settings and the option to enable stdin. Results distinguish successful spawn, rejection,
permission denial, unsupported sandbox, execution error and an unset result. The separate stdin operation
retains the shell id, input text, and terminal length recorded before the write.

Generated stream messages are converted only in
`adapters/interop/agent/background-shell-operation-adapter.ts`. The tests cover all spawn states, stdin
success/error, and remote and controlled resource paths.

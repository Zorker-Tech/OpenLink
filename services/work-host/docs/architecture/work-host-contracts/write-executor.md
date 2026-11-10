# Workspace Write Executor Contract

File writing is a Slate application operation. `source/packages/agent-exec/write-operation.ts` owns its
request and result types; edit, plan, image, attachment and output-spill features use these types rather
than generated transport messages.

## Request

`WriteExecutorArgs` carries a workspace path, optional text and byte payloads, call identity, encoding,
and whether written text should be returned. Text and bytes are separate fields so the adapter can
preserve both when a caller supplies both; callers that write one representation set only that field.

## Result

`WriteExecutorResult` preserves the written path, line count, byte count and optional read-back text on
success. Its failure variants distinguish read-only or permission refusal (including the affected
operation and directory), a full device, a rejected write, an ordinary write error and an unset result.

## Transport boundary

Generated request/result messages are converted only in
`adapters/interop/agent/write-operation-adapter.ts`. Read-only refusals, box byte writes, image output
and text spill all use the same Slate resource contract. Their existing user-visible errors and success
paths remain covered by the behavior suite.

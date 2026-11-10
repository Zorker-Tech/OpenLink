# Workspace Read Executor Contract

The workspace reader is a Slate application operation. Its public request and result types live in
`source/packages/agent-exec/read-operation.ts`; host features, local execution and box access depend
on those types rather than generated transport messages.

## Request

`ReadExecutorArgs` carries a path and optional call id, line offset, line limit and encoding hint. An
absent option stays absent throughout the Slate API. `offset` may be negative and `limit` may be zero;
the local and box readers keep their existing range semantics.

## Result

`ReadExecutorResult` is a discriminated union. Success carries the resolved path, line count, exact
`bigint` file size, truncation and range metadata, optional text or byte output, and an optional blob
reference. Failures preserve the distinctions between an execution error, policy rejection, missing
file, permission denial and invalid file. An unset transport result is represented as `unrecognized`.

Text and bytes remain separate output kinds. Image, PDF, video, terminal-record and ordinary text
reads keep their existing handling in the local reader. Large payloads may continue to travel by blob
reference where the existing path supplies one.

## Transport boundary

Ordinary and privacy-filtered reads remain distinct executor resources. The generated execution frame
conversion is confined to `adapters/interop/agent/read-exec-operation-adapter.ts`. The default box
connection uses Slate's versioned operation contract in `shared/box-exec-protocol.ts`; the retained
Connect bridge converts at its adapter boundary. Neither transport's message shape is the business
contract used by Work-host features.

The conversion tests cover every known result, absent output, text and byte output, blob references,
negative offsets, zero limits, and 64-bit file sizes. No reader capability or failure distinction is
removed by this boundary change.

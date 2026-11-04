import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ReadResult, ReadSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts"
import { slateShellReadAccessorFromInterop } from "../../source/adapters/interop/agent/shell-auto-review-read-adapter.ts"
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import { createContext } from "../../source/packages/context/context.ts"

describe("the shell auto-review read interop adapter", () => {
  it("encodes a generated read request and returns the Slate text record", async () => {
    const calls: unknown[] = []
    const reader = slateShellReadAccessorFromInterop({
      get(resource: unknown) {
        assert.equal(resource, readExecutorResource)
        return {
          async execute(context: unknown, args: { path: string; toolCallId: string; offset: number; limit: number }) {
            calls.push({ context, ...args })
            return new ReadResult({
              result: {
                case: "success",
                value: new ReadSuccess({
                  path: args.path,
                  totalLines: 3,
                  truncated: false,
                  output: { case: "content", value: "line one\nline two\nline three" },
                }),
              },
            })
          },
        }
      },
    } as never)

    const context = createContext()
    assert.deepEqual(await reader.read(context, { path: "/work/tool.js", toolCallId: "call-1", offset: 51, limit: 50 }), {
      content: "line one\nline two\nline three",
      totalLines: 3,
      truncated: false,
    })
    assert.deepEqual(calls, [{ context, path: "/work/tool.js", toolCallId: "call-1", offset: 51, limit: 50, encodingHint: undefined }])
  })

  it("leaves non-text and unsuccessful read variants absent", async () => {
    const answers = [
      new ReadResult({ result: { case: "error", value: { error: "no" } as never } }),
      new ReadResult({ result: { case: "success", value: new ReadSuccess({ output: { case: "data", value: new Uint8Array([1]) } }) } }),
    ]
    const reader = slateShellReadAccessorFromInterop({
      get() { return { async execute() { return answers.shift()! } } },
    } as never)
    const request = { path: "/work/tool.js", toolCallId: "call-1", offset: 1, limit: 2 }
    assert.equal(await reader.read(createContext(), request), undefined)
    assert.equal(await reader.read(createContext(), request), undefined)
  })
})

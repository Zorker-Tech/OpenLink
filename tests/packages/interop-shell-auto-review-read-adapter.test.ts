import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { slateShellReadAccessorFromInterop } from "../../source/adapters/interop/agent/shell-auto-review-read-adapter.ts"
import { readExecutorResource, type ReadExecutorArgs, type ReadExecutorResult } from "../../source/packages/agent-exec/read-operation.ts"
import { createContext } from "../../source/packages/context/context.ts"

describe("the shell auto-review read interop adapter", () => {
  it("encodes a generated read request and returns the Slate text record", async () => {
    const calls: unknown[] = []
    const reader = slateShellReadAccessorFromInterop({
      get(resource: unknown) {
        assert.equal(resource, readExecutorResource)
        return {
          async execute(context: unknown, args: ReadExecutorArgs): Promise<ReadExecutorResult> {
            calls.push({ context, ...args })
            return {
              kind: "success",
              path: args.path,
              totalLines: 3,
              fileSize: 29n,
              truncated: false,
              rangeApplied: true,
              output: { kind: "text", text: "line one\nline two\nline three" },
            }
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
    assert.deepEqual(calls, [{ context, path: "/work/tool.js", toolCallId: "call-1", offset: 51, limit: 50 }])
  })

  it("leaves non-text and unsuccessful read variants absent", async () => {
    const answers: ReadExecutorResult[] = [
      { kind: "error", path: "/work/tool.js", error: "no" },
      { kind: "success", path: "/work/tool.js", totalLines: 0, fileSize: 1n, truncated: false, rangeApplied: false, output: { kind: "data", bytes: new Uint8Array([1]) } },
    ]
    const reader = slateShellReadAccessorFromInterop({
      get() { return { async execute() { return answers.shift()! } } },
    } as never)
    const request = { path: "/work/tool.js", toolCallId: "call-1", offset: 1, limit: 2 }
    assert.equal(await reader.read(createContext(), request), undefined)
    assert.equal(await reader.read(createContext(), request), undefined)
  })
})

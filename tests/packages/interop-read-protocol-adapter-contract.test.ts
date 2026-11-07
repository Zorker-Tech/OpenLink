import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import type { HookContextEntry } from "../../source/packages/hooks-carriers/hook-additional-context.ts"
import type { ResourceAccessor } from "../../source/packages/agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts"
import { readExecutorResource, redactedReadExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import {
  createReadConversationPort,
  createReadExecutorPort,
  fromInteropReadToolResult,
  toInteropReadToolCall,
  toInteropReadToolResult,
} from "../../source/adapters/interop/agent/read-tool-protocol-adapter.ts"
import { ReadToolResult } from "../../source/adapters/interop/proto/generated/agent/v1/read_tool_pb.ts"
import { ToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import type {
  ReadExecutionRequest,
  ReadExecutorOptions,
  ReadToolResultModel,
} from "../../source/packages/agent/tools/core/read/read-contract.ts"
import type { ReadExecutorArgs, ReadExecutorResult } from "../../source/packages/agent-exec/read-operation.ts"

test("Slate read results encode and decode through the external transcript envelope", () => {
  const imageBytes = new Uint8Array([1, 2, 3])
  const modelResult: ReadToolResultModel = {
    result: {
      case: "success",
      value: {
        output: { case: "content", value: "one\ntwo" },
        path: "/workspace/file.txt",
        totalLines: 2,
        fileSize: 7,
        readRange: { startLine: 1, endLine: 2 },
        includeLineNumbers: true,
        relatedCursorRulePaths: ["/workspace/AGENTS.md"],
        relatedCursorRules: [{ fullPath: "/workspace/AGENTS.md", content: "Use Slate rules." }],
      },
    },
  }
  const wireResult = toInteropReadToolResult(modelResult)
  const wireCall = toInteropReadToolCall({ args: { path: "/workspace/file.txt", offset: 1, limit: 2 }, result: modelResult })

  assert.ok(wireResult instanceof ReadToolResult)
  assert.equal(wireResult.result.case, "success")
  assert.equal(wireCall.tool.case, "readToolCall")
  if (wireCall.tool.case !== "readToolCall") assert.fail("expected read call envelope")
  assert.equal(wireCall.tool.value.args?.path, "/workspace/file.txt")
  assert.equal(wireCall.tool.value.result?.result.case, "success")
  assert.deepEqual(fromInteropReadToolResult(wireResult), modelResult)

  for (const output of [
    { case: "data", value: imageBytes } as const,
    { case: "dataBlobId", value: imageBytes } as const,
    { case: "contentBlobId", value: imageBytes } as const,
  ]) {
    const encoded = toInteropReadToolResult({ result: { case: "success", value: { path: "/workspace/image.png", output } } })
    assert.equal(encoded.result.case, "success")
    assert.equal(fromInteropReadToolResult(encoded).result?.case, "success")
  }
})

test("the interaction bridge records a Slate call as the counterpart tool event", async () => {
  const context = createContext()
  let receivedCall: unknown
  let recordedCall: unknown
  const port = createReadConversationPort({
    async executeToolCall(
      _context: Context,
      call: ToolCall,
      callId: string,
      execute: (context: Context) => Promise<ReadToolResult>,
      merge: (result: ReadToolResult) => ToolCall,
      hookContextCollector?: HookContextEntry[],
    ) {
      receivedCall = call
      assert.equal(callId, "read-call-3")
      assert.deepEqual(hookContextCollector, [{ event: "beforeRead", text: "inspect" }])
      const result = await execute(context)
      recordedCall = merge(result)
      return result
    },
  })
  const result: ReadToolResultModel = { result: { case: "success", value: { path: "/repo/a.txt", output: { case: "content", value: "a" } } } }
  const hookContextCollector = [{ event: "beforeRead", text: "inspect" }]
  const returned = await port.executeToolCall(
    context,
    { args: { path: "/repo/a.txt" } },
    "read-call-3",
    async () => result,
    hookContextCollector,
  )

  assert.deepEqual(returned, result)
  assert.equal((receivedCall as { tool?: { case?: string } }).tool?.case, "readToolCall")
  assert.equal((recordedCall as { tool?: { case?: string; value?: { result?: ReadToolResult } } }).tool?.case, "readToolCall")
  const recordedResult = (recordedCall as { tool?: { value?: { result?: ReadToolResult } } }).tool?.value?.result
  assert.equal(recordedResult?.result.case, "success")
})

test("the executor adapter owns request construction and normalizes the wire response", async () => {
  const context = createContext()
  const calls: Array<{ request: ReadExecutorArgs; options: ReadExecutorOptions; resource: symbol }> = []
  const accessor = {
    get(resource: { symbol: symbol }) {
      return {
        async execute(_context: unknown, request: ReadExecutorArgs, options: ReadExecutorOptions): Promise<ReadExecutorResult> {
          calls.push({ request, options, resource: resource.symbol })
          return {
            kind: "success",
            path: request.path,
            totalLines: 1,
            fileSize: 4n,
            rangeApplied: true,
            truncated: false,
            output: { kind: "text", text: "text" },
          }
        },
      }
    },
  } as unknown as ResourceAccessor<RemoteExecManager>
  const request: ReadExecutionRequest = { path: "/repo/a.txt", toolCallId: "call-4", offset: 3, limit: 1 }
  const options: ReadExecutorOptions = { execId: "exec-4", hookContextCollector: [] }
  const result = await createReadExecutorPort(accessor, false).execute(context, request, options)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.resource, readExecutorResource.symbol)
  assert.deepEqual({
    path: calls[0]?.request.path,
    toolCallId: calls[0]?.request.toolCallId,
    offset: calls[0]?.request.offset,
    limit: calls[0]?.request.limit,
  }, request)
  assert.equal(calls[0]?.options.execId, options.execId)
  assert.equal(result.result.case, "success")
  if (result.result.case !== "success") assert.fail("expected read success")
  assert.equal(result.result.value.fileSize, 4)
  assert.deepEqual(result.result.value.output, { case: "content", value: "text" })

  await createReadExecutorPort(accessor, true).execute(context, request, options)
  assert.equal(calls[1]?.resource, redactedReadExecutorResource.symbol)
})

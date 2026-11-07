import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"

import { McpToolResultContentItem, McpTextContent } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"
import { OutputLocation } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts"
import type { WriteExecutorArgs, WriteExecutorResult } from "../../source/packages/agent-exec/write-operation.ts"
import {
  AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES,
  describeOutputLocation,
  materializeMcpTextOutput,
  writeToAgentToolsFile,
} from "../../source/adapters/interop/agent/agent-tools-file-adapter.ts"
import { MCP_TEXT_FILE_THRESHOLD_BYTES } from "../../source/packages/agent/tools/mcp/mcp-output-spill-policy.ts"
import { createContext } from "../../source/packages/context/context.ts"

function textItem(text: string, outputLocation?: OutputLocation): McpToolResultContentItem {
  return new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text, ...(outputLocation === undefined ? {} : { outputLocation }) }) } })
}

test("MCP text aggregation uses UTF-8 byte limits and replaces only inline text", async () => {
  const inline = [textItem("é"), textItem("tail")]
  assert.equal(await materializeMcpTextOutput({
    contentItems: inline,
    thresholdBytes: Buffer.byteLength("é\n\ntail", "utf8"),
    write: async () => assert.fail("exactly-at-threshold text remains inline"),
  }), inline)

  const location = new OutputLocation({ filePath: "/repo/agent-tools/output.txt", sizeBytes: 12n, lineCount: 2n })
  const image = { content: { case: "image", value: {} } } as unknown as McpToolResultContentItem
  const linkedText = textItem("already stored", location)
  const input = [textItem("first"), image, linkedText, textItem("second")]
  let written: string | undefined
  const output = await materializeMcpTextOutput({
    contentItems: input,
    thresholdBytes: 1,
    write: async value => { written = value; return location },
  })

  assert.equal(written, "first\n\nsecond")
  assert.equal(output?.length, 3)
  assert.equal(output?.[0]?.content.case, "text")
  if (output?.[0]?.content.case === "text") {
    assert.equal(output[0].content.value.text, "")
    assert.equal(output[0].content.value.outputLocation, location)
  }
  assert.equal(output?.[1], image)
  assert.equal(output?.[2], linkedText)
})

test("MCP text stays inline when disabled, already small, or has no writable destination", async () => {
  const items = [textItem("large enough")]
  assert.equal(await materializeMcpTextOutput({ contentItems: items, thresholdBytes: 0, write: async () => assert.fail("disabled spill does not write") }), items)
  assert.equal(await materializeMcpTextOutput({ contentItems: items, thresholdBytes: 100, write: async () => assert.fail("small spill does not write") }), items)
  assert.equal(await materializeMcpTextOutput({ contentItems: items, thresholdBytes: 1, write: async () => undefined }), undefined)
  assert.equal(AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES, 20_000)
  assert.equal(MCP_TEXT_FILE_THRESHOLD_BYTES, 40_000)
})

test("tool output files use a platform path, bounded content and the write executor's returned path", async () => {
  const calls: Array<{ context: unknown; args: WriteExecutorArgs }> = []
  const executor = {
    async execute(context: unknown, args: WriteExecutorArgs): Promise<WriteExecutorResult> {
      calls.push({ context, args })
      return { kind: "success", path: args.path, linesWritten: 1, bytesWritten: 4 }
    },
  }
  const context = createContext()
  const result = await writeToAgentToolsFile(context, executor as never, {
    content: "ébc\nunused",
    projectDir: "C:\\repo",
    osPlatform: "win32",
    toolCallId: "call-7",
    maxSize: 3,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.context, context)
  assert.equal(calls[0]?.args.path.startsWith(path.win32.join("C:\\repo", "agent-tools")), true)
  assert.equal(calls[0]?.args.path.endsWith(".txt"), true)
  assert.equal(calls[0]?.args.text, "ébc")
  assert.equal(calls[0]?.args.toolCallId, "call-7")
  assert.deepEqual(result, new OutputLocation({ filePath: calls[0]!.args.path, sizeBytes: 4n, lineCount: 1n }))
})

test("failed write outcomes do not fabricate an output location", async () => {
  const results: WriteExecutorResult[] = [
    { kind: "permission-denied", path: "/workspace/out.txt", directory: "/workspace", operation: "write", message: "no", isReadonly: true },
    { kind: "no-space", path: "/workspace/out.txt" },
    { kind: "error", path: "/workspace/out.txt", error: "no" },
    { kind: "rejected", path: "/workspace/out.txt", reason: "no" },
    { kind: "unrecognized" },
  ]
  for (const [index, writeResult] of results.entries()) {
    const executor = { async execute() { return writeResult } }
    assert.equal(await writeToAgentToolsFile(createContext(), executor as never, {
      content: "content", projectDir: "/workspace", osPlatform: "linux", toolCallId: "call",
    }), undefined, `failure ${index}`)
  }
})

test("output descriptions present sizes in readable units and honor a caller label", () => {
  assert.equal(
    describeOutputLocation(new OutputLocation({ filePath: "/repo/out.txt", sizeBytes: 1024n, lineCount: 2n })),
    "Content written to file: /repo/out.txt\nSize: 1.0 KB, 2 lines",
  )
  assert.match(describeOutputLocation(new OutputLocation({ filePath: "/repo/out.txt", sizeBytes: 512n, lineCount: 1n }), { leadText: "Full output" }), /^Full output written to file:/)
})

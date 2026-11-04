import assert from "node:assert/strict"
import { test } from "node:test"

import {
  AGENT_TOOLS_DIR,
  createSlateMcpTextSpiller,
  isLargeOutputSpillEnabled,
  MAX_OUTPUT_FILE_SIZE,
  SLATE_SHELL_FILE_OUTPUT_THRESHOLD_BYTES,
} from "../../source/host/runner/large-output-spill.ts"
import { MCP_TEXT_FILE_THRESHOLD_BYTES } from "../../source/packages/agent/tools/mcp/mcp-output-spill-policy.ts"
import {
  McpResult,
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
} from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"
import { OutputLocation } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts"

const textItem = (text: string, outputLocation?: OutputLocation) => new McpToolResultContentItem({
  content: { case: "text", value: new McpTextContent({ text, ...(outputLocation === undefined ? {} : { outputLocation }) }) },
})

const successResult = (content: McpToolResultContentItem[]) => new McpResult({
  result: { case: "success", value: new McpSuccess({ content }) },
})

test("the output-spill switch and host budget have Slate-owned defaults", () => {
  assert.equal(isLargeOutputSpillEnabled({}), true)
  assert.equal(isLargeOutputSpillEnabled({ SLATE_DISABLE_LARGE_OUTPUT_SPILL: "1" }), false)
  assert.equal(isLargeOutputSpillEnabled({ SLATE_DISABLE_LARGE_OUTPUT_SPILL: "true" }), true)
  assert.equal(MCP_TEXT_FILE_THRESHOLD_BYTES, 40_000)
  assert.equal(SLATE_SHELL_FILE_OUTPUT_THRESHOLD_BYTES, 40_000n)
  assert.equal(AGENT_TOOLS_DIR, ".slate/tools")
})

test("text at the byte threshold stays in the response", async () => {
  const writes: unknown[] = []
  const result = successResult([textItem("café")])
  const spill = createSlateMcpTextSpiller<{ owner: string }>({
    thresholdBytes: Buffer.byteLength("café", "utf8"),
    uploadTextFile: async (...args) => { writes.push(args) },
  })

  assert.equal(await spill({ owner: "agent" }, result), result)
  assert.deepEqual(writes, [])
})

test("large output is stored with a Slate path and only inline text becomes a file pointer", async () => {
  const uploads: Array<{ path: string; text: string }> = []
  const existingLocation = new OutputLocation({ filePath: "/repo/kept.txt", sizeBytes: 4n, lineCount: 1n })
  const image = new McpToolResultContentItem({ content: { case: "image", value: { data: new Uint8Array([7]), mimeType: "image/png" } as never } })
  const result = successResult([textItem("large payload"), image, textItem("already stored", existingLocation)])
  const spill = createSlateMcpTextSpiller<{ owner: string }>({
    thresholdBytes: 3,
    uploadTextFile: async (_ctx, path, data) => { uploads.push({ path, text: new TextDecoder().decode(data) }) },
  })

  const output = await spill({ owner: "agent" }, result)

  assert.notEqual(output, result)
  assert.equal(uploads.length, 1)
  assert.match(uploads[0]?.path ?? "", new RegExp(`^${AGENT_TOOLS_DIR}/[0-9a-f-]{36}\\.txt$`))
  assert.equal(uploads[0]?.text, "large payload")
  assert.equal(output.result.case, "success")
  if (output.result.case !== "success") return
  assert.equal(output.result.value.content.length, 3)
  const pointer = output.result.value.content[0]
  assert.equal(pointer?.content.case, "text")
  if (pointer?.content.case === "text") {
    assert.equal(pointer.content.value.text, "")
    assert.equal(pointer.content.value.outputLocation?.filePath, uploads[0]?.path)
    assert.equal(pointer.content.value.outputLocation?.sizeBytes, BigInt(Buffer.byteLength("large payload", "utf8")))
    assert.equal(pointer.content.value.outputLocation?.lineCount, 1n)
  }
  assert.equal(output.result.value.content[1], image)
  assert.equal(
    output.result.value.content[2]?.content.case === "text"
      ? output.result.value.content[2].content.value.outputLocation?.filePath
      : undefined,
    "/repo/kept.txt",
  )
})

test("stored text is capped before upload and failed uploads leave the original result intact", async () => {
  const huge = "x".repeat(MAX_OUTPUT_FILE_SIZE + 1)
  const captured: Uint8Array[] = []
  const capper = createSlateMcpTextSpiller<number>({
    thresholdBytes: 1,
    uploadTextFile: async (_ctx, _path, data) => { captured.push(data) },
  })
  const output = await capper(1, successResult([textItem(huge)]))
  assert.equal(captured[0]?.byteLength, MAX_OUTPUT_FILE_SIZE)
  assert.equal(output.result.case, "success")
  if (output.result.case === "success") {
    assert.equal(output.result.value.content[0]?.content.case === "text"
      ? output.result.value.content[0].content.value.outputLocation?.sizeBytes
      : undefined, BigInt(MAX_OUTPUT_FILE_SIZE))
  }

  const original = successResult([textItem("oversized")])
  const failed = createSlateMcpTextSpiller<number>({
    thresholdBytes: 1,
    uploadTextFile: async () => { throw new Error("box is offline") },
  })
  assert.equal(await failed(1, original), original)

  const failureResult = new McpResult({ result: { case: "error", value: { error: "remote failure" } as never } })
  assert.equal(await failed(1, failureResult), failureResult)
})

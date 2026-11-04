import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ReadArgs } from "../../source/adapters/interop/proto/generated/agent/v1/read_exec_pb.ts"
import { localReadArgsFromInterop, localReadOutcomeToInterop } from "../../source/adapters/interop/agent/local-read-executor-adapter.ts"
import type { LocalReadOutcome } from "../../source/packages/local-exec/read.ts"

describe("the local-read executor interop adapter", () => {
  it("projects the generated request fields into the Slate read request", () => {
    assert.deepEqual(localReadArgsFromInterop(new ReadArgs({ path: "/repo/a.txt", toolCallId: "call-1", offset: 2, limit: 3 })), {
      path: "/repo/a.txt",
      toolCallId: "call-1",
      offset: 2,
      limit: 3,
    })
  })

  it("encodes Slate text and byte outcomes without changing their read metadata", () => {
    const text: LocalReadOutcome = {
      kind: "success",
      path: "/repo/a.txt",
      output: { kind: "text", text: "hello" },
      totalLines: 1,
      fileSize: 5,
      truncated: false,
      rangeApplied: false,
    }
    const textResult = localReadOutcomeToInterop(text)
    assert.equal(textResult.result.case, "success")
    if (textResult.result.case !== "success") assert.fail("expected text read success")
    assert.equal(textResult.result.value.output.case, "content")
    assert.equal(textResult.result.value.output.value, "hello")
    assert.equal(textResult.result.value.fileSize, 5n)

    const bytes = new Uint8Array([1, 2, 3])
    const dataResult = localReadOutcomeToInterop({ ...text, output: { kind: "data", bytes } })
    assert.equal(dataResult.result.case, "success")
    if (dataResult.result.case !== "success") assert.fail("expected byte read success")
    assert.equal(dataResult.result.value.output.case, "data")
    assert.deepEqual(dataResult.result.value.output.value, bytes)
  })

  it("keeps read failures in their own executor cases", () => {
    assert.equal(localReadOutcomeToInterop({ kind: "not_found", path: "/repo/missing" }).result.case, "fileNotFound")
    assert.equal(localReadOutcomeToInterop({ kind: "permission_denied", path: "/repo/secret" }).result.case, "permissionDenied")
    assert.equal(localReadOutcomeToInterop({ kind: "invalid_file", path: "/repo/blob.bin", reason: "binary" }).result.case, "invalidFile")
    const failed = localReadOutcomeToInterop({ kind: "error", path: "/repo/a.txt", error: "broken" })
    assert.equal(failed.result.case, "error")
    if (failed.result.case !== "error") assert.fail("expected a read error")
    assert.equal(failed.result.value.error, "broken")
  })
})

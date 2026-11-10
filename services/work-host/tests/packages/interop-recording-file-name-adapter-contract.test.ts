import assert from "node:assert/strict"
import test from "node:test"
import { RequestedFilePathRejectedReason } from "../../source/adapters/interop/proto/generated/agent/v1/record_screen_exec_pb.ts"
import { validateRecordingFilenameForInterop } from "../../source/adapters/interop/agent/recording-file-name-adapter.ts"

test("the filename adapter maps Slate rejection reasons to the external enum", () => {
  assert.deepEqual(validateRecordingFilenameForInterop(" ", "/artifacts"), {
    success: false,
    reason: RequestedFilePathRejectedReason.UNSPECIFIED,
  })
  assert.deepEqual(validateRecordingFilenameForInterop("../record.mp4", "/artifacts"), {
    success: false,
    reason: RequestedFilePathRejectedReason.SLASHES_NOT_ALLOWED,
  })
})

test("the filename adapter forwards accepted names unchanged", () => {
  assert.deepEqual(validateRecordingFilenameForInterop("/artifacts/capture.mp4", "/artifacts"), {
    success: true,
    filename: "capture.mp4",
  })
})

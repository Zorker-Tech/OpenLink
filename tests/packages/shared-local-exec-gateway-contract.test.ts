import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES,
  GATEWAY_LOCAL_EXEC_REQUESTS_PATH,
  GATEWAY_LOCAL_EXEC_RESPONSES_PATH,
  localExecFileTooLargeMessage,
  localExecUploadFrameTooLargeMessage,
  maxLocalExecUploadFrameBytes,
  SLATE_COMPUTER_UNAVAILABLE_MESSAGE,
  SLATE_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS,
  SLATE_LOCAL_EXEC_DATA_POST_TIMEOUT_MS,
  SLATE_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS,
  SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS,
  SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS,
  SLATE_NO_LOCAL_MACHINE_MESSAGE,
  slateComputerUnavailableMessage,
  describeLocalExecBytes,
} from "../../source/shared/local-exec-gateway.ts";

describe("local-exec gateway contract", () => {
  it("keeps the route, timing and transfer limits stable", () => {
    assert.equal(GATEWAY_LOCAL_EXEC_REQUESTS_PATH, "/local-exec/requests");
    assert.equal(GATEWAY_LOCAL_EXEC_RESPONSES_PATH, "/local-exec/responses");
    assert.equal(SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS, 30_000);
    assert.equal(SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS, 10_000);
    assert.equal(SLATE_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS, 10_000);
    assert.equal(SLATE_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS, 10_000);
    assert.equal(SLATE_LOCAL_EXEC_DATA_POST_TIMEOUT_MS, 120_000);
    assert.equal(DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, 100 * 1024 * 1024);
  });

  it("formats sizes in MiB and explains file-read limits with usable alternatives", () => {
    assert.equal(describeLocalExecBytes(0), "0.0 MiB");
    assert.equal(describeLocalExecBytes(1024 * 1024), "1.0 MiB");
    const message = localExecFileTooLargeMessage(2 * 1024 * 1024, 1024 * 1024);
    assert.match(message, /2\.0 MiB/);
    assert.match(message, /1\.0 MiB/);
    assert.match(message, /offset\/limit/);
  });

  it("explains that oversized uploads stop before reading and can be split", () => {
    const message = localExecUploadFrameTooLargeMessage(1024 * 1024);
    assert.match(message, /1\.0 MiB/);
    assert.match(message, /before its contents were read into memory/);
    assert.match(message, /split/);
    assert.equal(maxLocalExecUploadFrameBytes(1024 * 1024), Math.ceil(1024 * 1024 * 4 / 3) + 64 * 1024);
  });

  it("distinguishes an absent machine from a named one that cannot be reached", () => {
    assert.match(SLATE_NO_LOCAL_MACHINE_MESSAGE, /Slate desktop app/);
    assert.match(SLATE_COMPUTER_UNAVAILABLE_MESSAGE, /Your computer is unavailable/);
    assert.match(slateComputerUnavailableMessage("Studio"), /"Studio"/);
    assert.equal(slateComputerUnavailableMessage(""), SLATE_COMPUTER_UNAVAILABLE_MESSAGE);
  });
});

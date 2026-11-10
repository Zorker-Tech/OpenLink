import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCodebaseTelemetryUploadCredentialsAdapter } from "../../source/adapters/interop/telemetry/codebase-telemetry-upload-credentials-adapter.ts";

describe("codebase telemetry upload credentials interop", () => {
  it("projects the account token and fetches a machine identity for every upload attempt", async () => {
    const machineIds: string[] = [];
    const options = {
      credentials: { authToken: "account-token" },
      auth: {
        getMachineId: async () => {
          const machineId = `machine-${machineIds.length + 1}`;
          machineIds.push(machineId);
          return machineId;
        },
      },
    };

    const first = await createCodebaseTelemetryUploadCredentialsAdapter(options);
    const second = await createCodebaseTelemetryUploadCredentialsAdapter(options);

    assert.deepEqual(machineIds, ["machine-1", "machine-2"]);
    assert.equal(first.authToken, "account-token");
    assert.equal(second.authToken, "account-token");
    assert.equal(typeof first.requestHeaders["x-cursor-checksum"], "string");
    assert.equal(first.requestHeaders["x-cursor-checksum"]!.length > 0, true);
    assert.equal(typeof second.requestHeaders["x-cursor-checksum"], "string");
    assert.equal(first.requestHeaders["x-ghost-mode"], "false");
    assert.equal(second.requestHeaders["x-ghost-mode"], "false");
  });
});

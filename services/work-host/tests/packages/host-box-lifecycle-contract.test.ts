import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBoxLifecycleBackendFromClient } from "../../source/adapters/interop/agent/box-lifecycle-backend-adapter.ts";
import { BoxLifecycleService } from "../../source/host/boxes/box-lifecycle/box-lifecycle-service.ts";

describe("box lifecycle boundary contract", () => {
  it("projects update availability, forwards cancellation, and normalizes rebuild outcomes", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const backend = createBoxLifecycleBackendFromClient({
      async getBoxRunState(input, options) {
        calls.push(["state", input, options.signal]);
        return { imageUpdateAvailable: true };
      },
      async recreateBox(input) {
        calls.push(["recreate", input]);
        return { started: false, reason: "busy", ignored: "wire detail" } as never;
      },
    });
    const service = new BoxLifecycleService(backend);

    assert.equal(await service.fetchImageUpdateAvailable(controller.signal), true);
    assert.deepEqual(await service.recreateInBox({ preserveData: false, force: true }), {
      started: false,
      reason: "busy",
    });
    assert.deepEqual(calls, [
      ["state", {}, controller.signal],
      ["recreate", { preserveData: false, force: true }],
    ]);
  });

  it("defaults a missing force choice to false and omits an absent reason", async () => {
    let request: unknown;
    const service = new BoxLifecycleService(createBoxLifecycleBackendFromClient({
      async getBoxRunState() { return { imageUpdateAvailable: false }; },
      async recreateBox(input) {
        request = input;
        return { started: true };
      },
    }));

    assert.deepEqual(await service.recreateInBox({ preserveData: true }), { started: true });
    assert.deepEqual(request, { preserveData: true, force: false });
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { localToolPermissionExtension } from "../../source/host/extensions/local-tool-permission/extension.ts";
import type { LocalToolPermissionTranscript } from "../../source/host/extensions/local-tool-permission/local-tool-permission-resolution.ts";
import { SLATE_NO_LOCAL_MACHINE_MESSAGE } from "../../source/shared/local-exec-gateway.ts";
import {
  SLATE_LOCAL_TOOLS_ASK_UNAVAILABLE_MESSAGE,
  type SlateLocalToolRequest,
  type SlateLocalToolScope,
} from "../../source/shared/local-tool-permission-machinery.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("local permission extension binds the decision surfaces and waits to sweep startup asks", async () => {
  const ready = deferred<void>();
  const sweepFinished = deferred<void>();
  const expiredBefore: number[] = [];
  const emitted: Array<{ topic: string; payload: unknown }> = [];
  let permission: "ask" | "always" | "never" = "ask";
  let strandedRetirements = 0;
  const transcript: LocalToolPermissionTranscript = {
    widgetResponses: {
      async settleStaleLocalToolPermissionCard() {
        return "retired";
      },
      async expireAllPendingLocalToolPermissionCards({ ifPendingBeforeMs }) {
        expiredBefore.push(ifPendingBeforeMs);
        sweepFinished.resolve();
      },
    },
  };
  const context = {
    deps: {
      [HostExtensions.Settings]: {
        getLocalToolPermission: () => permission,
        setLocalToolPermission: (next: "always" | "never") => {
          permission = next;
        },
      },
      [HostExtensions.Telemetry]: {
        logs: { reportLocalToolPermissionStrandedRetirement: () => strandedRetirements++ },
      },
      [HostExtensions.Transcript]: transcript,
    },
    host: {
      events: {
        emit: async (topic: string, payload: unknown) => {
          emitted.push({ topic, payload });
        },
      },
      whenBackgroundWorkReady: ready.promise,
      log: () => {},
    },
    onStop: () => {},
  };

  assert.equal(localToolPermissionExtension.id, HostExtensions.LocalToolPermission);
  assert.deepEqual(localToolPermissionExtension.dependencies, [
    HostExtensions.Settings,
    HostExtensions.Telemetry,
    HostExtensions.Transcript,
  ]);
  const api = await localToolPermissionExtension.start(context);
  assert.equal(api.permission(), "ask");
  assert.deepEqual(expiredBefore, []);

  const scope: SlateLocalToolScope = { agentId: "agent-a", toolCallId: "call-a" };
  const request: SlateLocalToolRequest = { action: "run-command", target: "pwd" };
  api.bindAskSurfaces(() => false);
  api.bindLiveComputerCheck(() => true);
  assert.deepEqual(await api.authorize(scope, request), {
    allowed: false,
    reason: SLATE_LOCAL_TOOLS_ASK_UNAVAILABLE_MESSAGE,
  });
  api.bindAskSurfaces(() => true);
  api.bindLiveComputerCheck(() => false);
  assert.deepEqual(await api.authorize(scope, request), {
    allowed: false,
    reason: SLATE_NO_LOCAL_MACHINE_MESSAGE,
  });

  api.bindLiveComputerCheck(() => true);
  const pendingDecision = api.authorize(scope, request);
  const pending = api.getPendingRequestForAgent("agent-a");
  assert.ok(pending);
  api.resolveRequest(pending.id, "allow-once");
  assert.equal((await pendingDecision).allowed, true);
  api.completeScope(scope);
  assert.deepEqual(emitted, [{
    topic: "local-tool-permission.approval-retired",
    payload: { approvalId: pending.id },
  }]);

  await api.resolveAsk({
    agentId: "agent-a",
    entryId: "entry-a",
    requestId: "orphaned-request",
    resolution: "allow-once",
  });
  assert.equal(strandedRetirements, 1);

  ready.resolve();
  await sweepFinished.promise;
  assert.equal(expiredBefore.length, 1);
  assert.ok(expiredBefore[0] !== undefined && expiredBefore[0] <= Date.now());
});

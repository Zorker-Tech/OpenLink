import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BoxEnvironmentSyncUnsupportedError,
  BoxMcpUnsupportedError,
} from "../../source/host/ports/box.ts";
import {
  boxAgentWindowIndex,
  boxApplyEnvironment,
  boxDescription,
  boxIsAvailable,
  boxIsPreparing,
  boxLoadMcpServers,
  boxMaxWindows,
  boxMcpResourceAccessor,
  boxSupportsMultiWindow,
  boxTerminalsFolder,
  type BoxCapabilityPort,
} from "../../source/host/boxes/box-capabilities.ts";

test("optional box observations default safely and preserve supplied values", async () => {
  const empty: BoxCapabilityPort = {};
  assert.equal(boxMaxWindows(empty), 1);
  assert.equal(boxSupportsMultiWindow(empty), false);
  assert.equal(boxAgentWindowIndex(empty, "agent-a"), undefined);
  assert.equal(boxTerminalsFolder(empty), undefined);
  assert.equal(await boxIsAvailable(empty), true);
  assert.equal(boxIsPreparing(empty, "agent-a"), false);
  assert.equal(boxDescription(empty), undefined);

  const populated: BoxCapabilityPort = {
    maxWindows: () => 2,
    getAgentWindowIndex: () => 1,
    getTerminalsFolder: () => "/box/terminals",
    isAvailable: async () => false,
    isPreparing: () => true,
    describe: () => ({ kind: "shared" }),
  };
  assert.equal(boxMaxWindows(populated), 2);
  assert.equal(boxSupportsMultiWindow(populated), true);
  assert.equal(boxAgentWindowIndex(populated, "agent-a"), 1);
  assert.equal(boxTerminalsFolder(populated), "/box/terminals");
  assert.equal(await boxIsAvailable(populated), false);
  assert.equal(boxIsPreparing(populated, "agent-a"), true);
  assert.deepEqual(boxDescription(populated), { kind: "shared" });
});

test("unsupported box operations fail explicitly and supported calls preserve their arguments", async () => {
  const context = {} as never;
  const empty: BoxCapabilityPort = {};
  await assert.rejects(boxApplyEnvironment(empty, context, {}), BoxEnvironmentSyncUnsupportedError);
  await assert.rejects(boxLoadMcpServers(empty, context, "{}"), BoxMcpUnsupportedError);
  await assert.rejects(boxMcpResourceAccessor(empty, context), BoxMcpUnsupportedError);

  const seen: unknown[][] = [];
  const capable: BoxCapabilityPort = {
    applyEnvironment: async (...args) => { seen.push(args); },
    loadMcpServers: async (...args) => { seen.push(args); return { serverCount: 2 }; },
    mcpResourceAccessor: async (...args) => { seen.push(args); return { read: true }; },
  };
  const update = { PATH: "/bin" };
  await boxApplyEnvironment(capable, context, update);
  assert.deepEqual(await boxLoadMcpServers(capable, context, "{}"), { serverCount: 2 });
  assert.deepEqual(await boxMcpResourceAccessor(capable, context), { read: true });
  assert.deepEqual(seen, [[context, update], [context, "{}"], [context]]);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { createContext } from "../../source/packages/context/context.ts";
import { createSessionProductionHandoffDependencies } from "../../source/host/extensions/session/session-production-handoff.ts";

test("the session handoff maps lifecycle events and telemetry to host ports", async () => {
  const calls: Array<{ topic: string; payload: unknown; options?: unknown }> = [];
  const telemetry: unknown[] = [];
  const dependencies = createSessionProductionHandoffDependencies({
    box: { async ensureReady() { return {}; } },
    context: createContext(),
    events: {
      async emit(topic, payload, options) {
        calls.push({ topic, payload, ...(options === undefined ? {} : { options }) });
      },
    },
    telemetry: {
      reportBoxHelp: event => telemetry.push(["help", event]),
      trackEvent: (name, properties) => telemetry.push(["event", name, properties]),
    },
  });

  dependencies.onStarted?.({ agentId: "agent-1", instruction: "return control" });
  dependencies.onStatusChanged?.("agent-1");
  await dependencies.onEnded?.({
    agentId: "agent-1",
    requestId: "request-1",
    resolution: "completed",
    trigger: "user",
  });
  dependencies.telemetry?.reportBoxHelp({ source: "handoff" });
  dependencies.telemetry?.trackEvent("handoff", { result: "completed" });

  assert.deepEqual(calls, [
    {
      topic: "session.box-handoff-started",
      payload: { agentId: "agent-1", instruction: "return control" },
    },
    {
      topic: "session.box-handoff-status-changed",
      payload: { agentId: "agent-1" },
    },
    {
      topic: "session.box-handoff-ended",
      payload: { agentId: "agent-1", requestId: "request-1", resolution: "completed", trigger: "user" },
      options: { failureMode: "reject" },
    },
  ]);
  assert.deepEqual(telemetry, [
    ["help", { source: "handoff" }],
    ["event", "handoff", { result: "completed" }],
  ]);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { traysExtension } from "../../source/host/notifications/trays/extension.ts";

test("the trays extension exposes the host's tray operations and forwards events", () => {
  assert.equal(traysExtension.kind, "host-extension");
  assert.equal(traysExtension.id, HostExtensions.Trays);
  assert.deepEqual(traysExtension.dependencies, []);

  const service = traysExtension.start({ deps: {}, host: {}, onStop: () => {} }) as {
    list(): readonly { id: string; title: string }[];
    pushError(options: { title: string; detail: string; agentId?: string }): { id: string; title: string };
    dismiss(input: { id: string }): boolean;
    clearForAgent(agentId: string): void;
    clearAll(): void;
    subscribe(listener: (event: { type: string }) => void): () => void;
  };
  const events: string[] = [];
  const unsubscribe = service.subscribe((event) => events.push(event.type));

  const first = service.pushError({ title: "First", detail: "one", agentId: "agent-1" });
  const second = service.pushError({ title: "Second", detail: "two", agentId: "agent-2" });
  assert.deepEqual(service.list().map(({ title }) => title), ["First", "Second"]);
  assert.equal(service.dismiss({ id: first.id }), true);
  service.clearForAgent("agent-2");
  assert.deepEqual(service.list(), []);
  assert.deepEqual(events, ["pushed", "pushed", "dismissed", "dismissed"]);

  unsubscribe();
  service.pushError({ title: "After unsubscribe", detail: "three" });
  service.clearAll();
  assert.deepEqual(events, ["pushed", "pushed", "dismissed", "dismissed"]);
  assert.equal(second.title, "Second");
});

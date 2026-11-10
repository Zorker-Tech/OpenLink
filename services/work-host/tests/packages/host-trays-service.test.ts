import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_TRAYS, TrayManager, type TrayEvent } from "../../source/host/notifications/trays/trays-service.ts";

/** A manager whose ids and clock are predictable, and which records what it published. */
function manager(): { readonly trays: TrayManager; readonly events: TrayEvent[]; readonly raised: (options: Record<string, unknown>) => ReturnType<TrayManager["pushError"]> } {
  let nextId = 0;
  let clock = 1_000;
  const trays = new TrayManager(() => `id-${++nextId}`, () => (clock += 10));
  const events: TrayEvent[] = [];
  trays.subscribe((event) => events.push(event));
  return {
    trays,
    events,
    raised: (options) => trays.pushError({ title: "a title", detail: "a detail", ...options }),
  };
}

describe("raising a tray", () => {
  it("takes its own id and the moment it was raised", () => {
    const { trays, raised } = manager();
    const tray = raised({ agentId: "a1", requestId: "r1" });
    assert.equal(tray.kind, "error");
    assert.equal(tray.id, "id-1");
    assert.equal(tray.createdAt, 1_010);
    assert.equal(tray.agentId, "a1");
    assert.equal(tray.requestId, "r1");
    assert.deepEqual(trays.getTrays(), [tray]);
  });

  it("carries only the optional fields that were brought, and a count only when it can be de-duplicated", () => {
    const { raised } = manager();
    const plain = raised({});
    assert.equal("errorKind" in plain, false);
    assert.equal("rawDetail" in plain, false);
    assert.equal("actions" in plain, false);
    assert.equal("dedupeKey" in plain, false);
    const withExtras = raised({ errorKind: "network", rawDetail: "raw", actions: [{ label: "retry" }], dedupeKey: "k" });
    assert.equal(withExtras.errorKind, "network");
    assert.equal(withExtras.rawDetail, "raw");
    assert.deepEqual(withExtras.actions, [{ label: "retry" }]);
    assert.equal(withExtras.count, 1);
    assert.equal("actions" in raised({ actions: [] }), false, "an empty list of actions is not an offer");
  });

  it("publishes each tray as it is raised", () => {
    const { events, raised } = manager();
    const tray = raised({});
    assert.deepEqual(events, [{ type: "pushed", tray }]);
  });
});

describe("a tray about the same thing", () => {
  it("is brought up to date rather than raised again, and counted", () => {
    const { trays, events, raised } = manager();
    const first = raised({ dedupeKey: "k", title: "first" });
    const second = raised({ dedupeKey: "k", title: "second" });
    assert.equal(second.id, first.id, "the same tray, in the same place");
    assert.equal(second.title, "second");
    assert.equal(second.count, 2);
    assert.equal(trays.getTrays().length, 1);
    assert.deepEqual(events.map((event) => event.type), ["pushed", "pushed"]);
  });

  it("takes the count the caller brought instead of counting again", () => {
    const { raised } = manager();
    raised({ dedupeKey: "k" });
    assert.equal(raised({ dedupeKey: "k", count: 9 }).count, 9);
  });

  it("counts from one when the caller brings a count the first time", () => {
    const { raised } = manager();
    assert.equal(raised({ dedupeKey: "k", count: 4 }).count, 4);
    assert.equal(raised({ dedupeKey: "k" }).count, 5);
  });

  it("keeps its place among the other trays", () => {
    const { trays, raised } = manager();
    raised({ dedupeKey: "first" });
    raised({ dedupeKey: "second" });
    const refreshed = raised({ dedupeKey: "first", title: "again" });
    assert.deepEqual(trays.getTrays().map((tray) => tray.title), ["again", "a title"]);
    assert.equal(trays.getTrays()[0], refreshed);
  });
});

describe("the tray list a reader gets", () => {
  it("is the list as it stood: a later tray does not edit a list already handed out", () => {
    const { trays, raised } = manager();
    raised({});
    const kept = trays.getTrays();
    raised({});
    assert.equal(kept.length, 1);
    assert.equal(trays.getTrays().length, 2);
  });

  it("keeps the newest, dismissing the oldest one first when it overflows", () => {
    const { trays, events, raised } = manager();
    for (let index = 0; index < MAX_TRAYS + 2; index += 1) raised({ agentId: `a${index}` });
    assert.equal(trays.getTrays().length, MAX_TRAYS);
    assert.equal(trays.getTrays()[0]?.agentId, "a2");
    const dismissed = events.filter((event) => event.type === "dismissed").map((event) => (event as { id: string }).id);
    assert.deepEqual(dismissed, ["id-1", "id-2"]);
    assert.equal(MAX_TRAYS, 20);
  });
});

describe("dismissing", () => {
  it("removes the one tray and says so, and answers whether it found it", () => {
    const { trays, events, raised } = manager();
    const tray = raised({});
    assert.equal(trays.dismiss(tray.id), true);
    assert.equal(trays.dismiss(tray.id), false);
    assert.deepEqual(trays.getTrays(), []);
    assert.deepEqual(events.at(-1), { type: "dismissed", id: tray.id });
  });

  it("clears every tray an agent raised, one event each, in the order they were raised", () => {
    const { trays, events, raised } = manager();
    const first = raised({ agentId: "a1" });
    raised({ agentId: "a2" });
    const second = raised({ agentId: "a1" });
    trays.clearForAgent("a1");
    assert.deepEqual(trays.getTrays().map((tray) => tray.agentId), ["a2"]);
    assert.deepEqual(events.filter((event) => event.type === "dismissed"), [
      { type: "dismissed", id: first.id },
      { type: "dismissed", id: second.id },
    ]);
    const before = events.length;
    trays.clearForAgent("nobody");
    assert.equal(events.length, before, "an agent with no trays publishes nothing");
  });

  it("clears everything once, and publishes nothing when there is nothing to clear", () => {
    const { trays, events, raised } = manager();
    raised({});
    raised({});
    trays.clearAll();
    assert.deepEqual(trays.getTrays(), []);
    assert.equal(events.filter((event) => event.type === "cleared").length, 1);
    const before = events.length;
    trays.clearAll();
    assert.equal(events.length, before);
  });
});

describe("listening", () => {
  it("stops telling a listener it stopped listening for", () => {
    const { trays } = manager();
    const seen: TrayEvent[] = [];
    const stop = trays.subscribe((event) => seen.push(event));
    trays.pushError({ title: "t", detail: "d" });
    stop();
    trays.pushError({ title: "t", detail: "d" });
    assert.equal(seen.length, 1);
  });
});

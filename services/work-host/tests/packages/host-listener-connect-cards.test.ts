import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  connectCardsFor,
  type ConnectCardNeeds,
} from "../../source/host/runner/tools/listener-connect-cards.ts";

/** The cards a trigger raises, and what the agent is told about them. */
async function surface(options: {
  platforms: string[];
  connected?: (platform: string) => Promise<boolean>;
  spokenName?: (platform: string) => string;
  withoutConnectCheck?: boolean;
}): Promise<{ readonly answer: string | null; readonly cards: Array<{ platform: string; reason: string }> }> {
  const cards: Array<{ platform: string; reason: string }> = [];
  const needs: ConnectCardNeeds = {
    trigger: {},
    platformsOf: () => options.platforms,
    ...(options.withoutConnectCheck === true ? {} : { platformIsConnected: options.connected ?? (async () => true) }),
    emit: (card) => cards.push({ platform: card.platform, reason: card.reason }),
    ...(options.spokenName === undefined ? {} : { spokenName: options.spokenName }),
  };
  return { answer: await connectCardsFor(needs), cards };
}

describe("a listener that is not connected yet", () => {
  it("gets a card for the platform it needs, and the agent is told how to speak of it", async () => {
    const { answer, cards } = await surface({ platforms: ["slack"], connected: async () => false });
    assert.deepEqual(cards, [{ platform: "slack", reason: "so this routine can fire" }]);
    assert.match(answer ?? "", /^slack isn't connected to the user's Slate account yet, so this routine won't fire until they connect\./);
    assert.match(answer ?? "", /say so in your own words, but don't paste a link or send them to settings/);
  });

  it("asks for every platform that is not connected, and says them as a list", async () => {
    const { answer, cards } = await surface({ platforms: ["slack", "github"], connected: async (platform) => platform === "github" });
    assert.deepEqual(cards.map((card) => card.platform), ["slack"]);
    assert.match(answer ?? "", /^slack isn't connected/);
    const two = await surface({ platforms: ["slack", "github"], connected: async () => false, spokenName: (platform) => (platform === "slack" ? "Slack" : "GitHub") });
    assert.deepEqual(two.cards.map((card) => card.platform), ["slack", "github"]);
    assert.match(two.answer ?? "", /^Slack and GitHub aren't connected/);
  });

  it("says nothing rather than asking when there is no way to ask, even with platforms to check", async () => {
    // The guard is before the platforms are read, so a dependency without it would raise a card it cannot check.
    const cards: unknown[] = [];
    const answer = await connectCardsFor({ trigger: {}, platformsOf: () => ["slack"], emit: (card: unknown) => cards.push(card) } as never);
    assert.equal(answer, null);
    assert.deepEqual(cards, []);
  });

  it("says nothing when every platform is connected, when there are none, and when there is no way to ask", async () => {
    assert.deepEqual(await surface({ platforms: ["slack"], connected: async () => true }), { answer: null, cards: [] });
    assert.deepEqual(await surface({ platforms: [] }), { answer: null, cards: [] });
    assert.deepEqual(await surface({ platforms: ["slack"], withoutConnectCheck: true }), { answer: null, cards: [] });
  });

  it("takes a connection it could not ask about as connected, rather than carding something that may already be there", async () => {
    assert.deepEqual(await surface({ platforms: ["slack"], connected: async () => { throw new Error("no answer"); } }), { answer: null, cards: [] });
  });
});

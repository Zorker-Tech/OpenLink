import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONNECTOR_MANIFESTS,
  DISCORD_PLATFORM,
  SLACK_PLATFORM,
  findConnectorManifest,
  formatChannelAddress,
  hasChannelsToShow,
  parseChannelAddress,
  type ConnectorManifest,
} from "../../source/host/channels/channels.ts";

describe("the descriptions of the platforms", () => {
  it("is one description per platform, in the order a surface shows them", () => {
    assert.equal(DISCORD_PLATFORM, "discord");
    assert.equal(SLACK_PLATFORM, "slack");
    assert.deepEqual(CONNECTOR_MANIFESTS.map((manifest) => manifest.platform), ["discord", "slack"]);
  });

  it("describes each one the same way, and says what it is called and what it needs", () => {
    for (const manifest of CONNECTOR_MANIFESTS) {
      assert.equal(manifest.displayName.length > 0, true);
      assert.equal(manifest.blurb.length > 0, true);
      assert.equal(manifest.credentialLabel.length > 0, true);
      assert.equal(manifest.availability === "available" || manifest.availability === "coming-soon", true);
      assert.equal(typeof manifest.connectGuide, "string");
    }
    assert.deepEqual(CONNECTOR_MANIFESTS.map((manifest) => [manifest.displayName, manifest.credentialLabel]), [["Discord", "bot token"], ["Slack", "app token"]]);
  });

  it("describes both as not connectable yet, with nothing to follow", () => {
    assert.deepEqual(CONNECTOR_MANIFESTS.filter((manifest) => manifest.availability === "available"), []);
    assert.deepEqual(CONNECTOR_MANIFESTS.map((manifest) => manifest.connectGuide), ["", ""]);
  });

  it("is looked up by the platform it describes", () => {
    assert.equal(findConnectorManifest(DISCORD_PLATFORM)?.displayName, "Discord");
    assert.equal(findConnectorManifest(SLACK_PLATFORM)?.displayName, "Slack");
  });

  it("answers nothing for a platform it does not describe, including one every object has", () => {
    for (const platform of ["other", "Discord", "", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.equal(findConnectorManifest(platform), undefined, platform);
    }
  });
});

describe("whether a surface has channels to show", () => {
  const comingSoon: ConnectorManifest = { platform: "x", displayName: "X", blurb: "", credentialLabel: "", availability: "coming-soon", connectGuide: "" };
  const available: ConnectorManifest = { ...comingSoon, platform: "y", availability: "available" };

  it("shows one when a platform can be connected", () => {
    assert.equal(hasChannelsToShow([available], []), true);
    assert.equal(hasChannelsToShow([comingSoon, available], []), true);
  });

  it("shows one when something is already connected, even with nothing connectable", () => {
    assert.equal(hasChannelsToShow([comingSoon], [{}]), true);
    assert.equal(hasChannelsToShow([], [{}]), true);
  });

  it("shows none when nothing is connectable and nothing is connected", () => {
    assert.equal(hasChannelsToShow([], []), false);
    assert.equal(hasChannelsToShow([comingSoon], []), false);
    assert.equal(hasChannelsToShow(CONNECTOR_MANIFESTS, []), false);
  });
});

describe("an address on a platform", () => {
  it("is written with the platform and the chat on either side of a colon", () => {
    assert.equal(formatChannelAddress({ platform: "slack", chat: "C123" }), "slack:C123");
    assert.equal(formatChannelAddress({ platform: "a", chat: "b:c" }), "a:b:c");
  });

  it("is read back at its first colon, so a chat may hold colons of its own", () => {
    assert.deepEqual(parseChannelAddress("slack:C123"), { platform: "slack", chat: "C123" });
    assert.deepEqual(parseChannelAddress("slack:a:b:c"), { platform: "slack", chat: "a:b:c" });
  });

  it("is trimmed on both sides, because an address is written by hand as often as it is built", () => {
    assert.deepEqual(parseChannelAddress("  slack  :  C123  "), { platform: "slack", chat: "C123" });
    assert.deepEqual(parseChannelAddress(" slack : a:b "), { platform: "slack", chat: "a:b" });
  });

  it("names no channel when one side of the colon is empty, or when there is no colon", () => {
    for (const raw of ["", "no-colon", ":chat", "platform:", " : ", "   "]) assert.equal(parseChannelAddress(raw), null, raw);
  });

  it("round-trips the addresses it writes", () => {
    for (const address of [{ platform: "slack", chat: "C123" }, { platform: "discord", chat: "guild/channel" }]) {
      assert.deepEqual(parseChannelAddress(formatChannelAddress(address)), address);
    }
  });
});

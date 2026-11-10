import { test } from "node:test"
import assert from "node:assert/strict"

import { CONNECTOR_MANIFESTS, DISCORD_PLATFORM, findConnectorManifest, formatChannelAddress, hasChannelsToShow, SLACK_PLATFORM } from "../../source/host/channels/channels.ts"
import { CHANNEL_INBOUND_WAKE_CUE, CHANNEL_MAX_LABEL_LENGTH, clampChannelLabel, renderChannelsSystemPrompt } from "../../source/host/channels/channel-messaging.ts"

// ---------------------------------------------------------------------------------------------
// The platforms a channel can be
// ---------------------------------------------------------------------------------------------

test("each messaging platform is described the same way", () => {
  assert.equal(DISCORD_PLATFORM, "discord")
  assert.equal(SLACK_PLATFORM, "slack")
  assert.equal(CONNECTOR_MANIFESTS.length > 0, true)
  for (const manifest of CONNECTOR_MANIFESTS) {
    assert.equal(manifest.platform.length > 0, true)
    assert.equal(manifest.displayName.length > 0, true)
  }

  // A platform is found by its id, and one nobody describes is not found rather than guessed at.
  const first = CONNECTOR_MANIFESTS[0]!
  assert.equal(findConnectorManifest(first.platform)?.platform, first.platform)
  assert.equal(findConnectorManifest("nobody"), undefined)

  // Channels are shown when a platform can be connected or a connection exists; otherwise there is nothing to
  // offer and nothing is shown.
  assert.equal(hasChannelsToShow([], []), false)
  assert.equal(hasChannelsToShow([{ ...first, availability: "available" }], []), true)
  assert.equal(hasChannelsToShow([{ ...first, availability: "coming-soon" }], [{}]), true)
})

test("an address on a channel names the platform and the chat it is in", () => {
  assert.equal(formatChannelAddress({ platform: "slack", chat: "C123" }), "slack:C123")
})

// ---------------------------------------------------------------------------------------------
// Talking on a channel
// ---------------------------------------------------------------------------------------------

test("what a channel message means is said in the prompt", () => {
  assert.equal(CHANNEL_INBOUND_WAKE_CUE, "[inbound]")
  // Nothing is said when there is nowhere for a channel to live, and nothing when there is no location.
  assert.equal(renderChannelsSystemPrompt(CONNECTOR_MANIFESTS, [], undefined), "")
  const section = renderChannelsSystemPrompt(
    CONNECTOR_MANIFESTS.map(manifest => ({ ...manifest, availability: "available" as const })),
    [],
    "/home/user/.slate/channels",
  )
  assert.match(section, /Channels: outside messaging surfaces/)
  // A message from a channel is a real person, and a reply goes back to that channel.
  assert.match(section, new RegExp(CHANNEL_INBOUND_WAKE_CUE))
  assert.match(section, /Reply to them on that same channel/)
  // What only this app can show is degraded to text for the other side.
  assert.match(section, /degrade them to text/)
  assert.match(section, /slate-agent cards/)

  // A channel's own label is bounded, and one that says nothing is not invented.
  assert.equal(clampChannelLabel("x".repeat(CHANNEL_MAX_LABEL_LENGTH + 10)).length, CHANNEL_MAX_LABEL_LENGTH)
  assert.equal(clampChannelLabel("  spaced  "), "spaced")
})

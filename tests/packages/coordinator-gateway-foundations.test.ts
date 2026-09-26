import { test } from "node:test"
import assert from "node:assert/strict"

import { coordinatorEventFamilyForSseChannel, SSE_CHANNEL_BY_FAMILY } from "../../source/coordinator/gateway/gateway-event-families.ts"
import { SseBlockDecoder } from "../../source/coordinator/gateway/sse-block-decoder.ts"
import { loopbackBindHosts, parseLoopbackRedirect } from "../../source/coordinator/oauth/mcp-oauth-loopback-registry.ts"
import { SIGNER_BINARY } from "../../source/coordinator/webauthn/signer.ts"
import { buildBoxNoVncUrl, isBoxSpecialTreatmentNoVncUrl } from "../../source/packages/constants/box-endpoints.ts"

// ---------------------------------------------------------------------------------------------
// Reading what a gateway sends
// ---------------------------------------------------------------------------------------------

test("a block that arrives in pieces is handed over whole", () => {
  const blocks: string[] = []
  const decoder = new SseBlockDecoder(block => blocks.push(block))
  const encoder = new TextEncoder()

  // Nothing is handed over until the block's separator arrives.
  decoder.push(encoder.encode("event: agents\ndata: one"))
  assert.deepEqual(blocks, [])
  decoder.push(encoder.encode("\n\n"))
  assert.equal(blocks.length, 1)
  assert.match(blocks[0] ?? "", /data: one/)

  // Several blocks in one read are handed over one at a time, in order.
  decoder.push(encoder.encode("data: two\n\ndata: three\n\n"))
  assert.deepEqual(blocks.length, 3)
  assert.match(blocks[1] ?? "", /data: two/)
  assert.match(blocks[2] ?? "", /data: three/)
})

test("a family's channel is the channel a client subscribes to", () => {
  for (const [family, channel] of Object.entries(SSE_CHANNEL_BY_FAMILY)) {
    assert.equal(coordinatorEventFamilyForSseChannel(channel), family)
  }
  // A channel nobody maps is not a family rather than being guessed at.
  assert.equal(coordinatorEventFamilyForSseChannel("nobody"), null)
})

// ---------------------------------------------------------------------------------------------
// Where an OAuth flow comes back to
// ---------------------------------------------------------------------------------------------

test("an OAuth flow comes back to a port on this machine", () => {
  assert.deepEqual(parseLoopbackRedirect(new URL("http://127.0.0.1:41234/callback")), { port: 41_234 })
  assert.deepEqual(parseLoopbackRedirect(new URL("http://localhost:9999/callback")), { port: 9_999 })
  // Anywhere else, or with no port at all, is refused rather than opened.
  assert.throws(() => parseLoopbackRedirect(new URL("https://example.com:443/callback")), /must be a localhost HTTP URL/)
  assert.throws(() => parseLoopbackRedirect(new URL("http://127.0.0.1/callback")), /must include a port/)

  // A name that could be either address is bound on both, so a browser that resolves it either way arrives.
  assert.deepEqual(loopbackBindHosts("localhost"), ["127.0.0.1", "::1"])
  assert.deepEqual(loopbackBindHosts("127.0.0.1"), ["127.0.0.1"])
})

// ---------------------------------------------------------------------------------------------
// The signer and a box's desktop
// ---------------------------------------------------------------------------------------------

test("the signer the platform ships is its own program", () => {
  assert.equal(SIGNER_BINARY.startsWith("slate-webauthn-signer"), true)
  assert.equal(SIGNER_BINARY.endsWith(".exe"), process.platform === "win32")
})

test("a box's desktop is addressed through the gateway, with the token it needs", () => {
  const url = buildBoxNoVncUrl("https://gateway.example/boxes/1", "network-token")
  // The viewer is the ordinary one, and it carries the token and the resume window the connection needs.
  assert.match(url, /^https:\/\/gateway\.example\/boxes\/1\/vnc\.html\?/)
  assert.match(url, /network_token=network-token/)
  assert.match(url, /path=websockify%3F/)
  assert.equal(isBoxSpecialTreatmentNoVncUrl(url), false)

  // The other viewer is used when the box asked for it, and is recognized as such.
  const special = buildBoxNoVncUrl("https://gateway.example/boxes/1", "network-token", undefined, true)
  assert.equal(isBoxSpecialTreatmentNoVncUrl(special), true)
  assert.equal(special.includes("slate-special-treatment-v1/vnc.html"), true)
})

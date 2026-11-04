import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BOX_FORK_NOVNC_PORT,
  BOX_PRIMARY_NOVNC_PORT,
  buildBoxNoVncUrl,
  isBoxSpecialTreatmentNoVncUrl,
} from "../../source/packages/constants/box-endpoints.ts"
import {
  proxifyBoxVncUrl,
  proxifyForeverBoxStatus,
  type VncProxyDescriptor,
} from "../../source/coordinator/gateway/box-vnc-proxy.ts"

const proxy: VncProxyDescriptor = {
  primaryUrl: "https://gateway.example/boxes/1/vnc.html?network_token=network",
  forkBaseUrl: "https://gateway.example/boxes/1/forks",
  networkToken: "network",
}

test("primary loopback desktops use the host-provided URL", () => {
  assert.equal(
    proxifyBoxVncUrl(`http://127.0.0.1:${BOX_PRIMARY_NOVNC_PORT}/vnc.html`, proxy),
    proxy.primaryUrl,
  )
  assert.equal(
    proxifyBoxVncUrl(`http://localhost:${BOX_PRIMARY_NOVNC_PORT}/vnc.html`, proxy),
    proxy.primaryUrl,
  )
})

test("fork URLs preserve the nested display token and special viewer route", () => {
  const specialProxy = {
    ...proxy,
    primaryUrl: buildBoxNoVncUrl("https://gateway.example/boxes/1", "network", undefined, true),
  }
  const source = `http://localhost:${BOX_FORK_NOVNC_PORT}/vnc.html?path=${encodeURIComponent("websockify?token=fork-token")}`

  assert.equal(
    proxifyBoxVncUrl(source, specialProxy),
    buildBoxNoVncUrl(
      specialProxy.forkBaseUrl,
      specialProxy.networkToken,
      "fork-token",
      isBoxSpecialTreatmentNoVncUrl(specialProxy.primaryUrl),
    ),
  )
})

test("unrecognized, non-loopback and malformed viewer URLs are left alone", () => {
  const candidates = [
    "not a URL",
    "https://remote.example/vnc.html",
    `http://127.0.0.2:${BOX_PRIMARY_NOVNC_PORT}/vnc.html`,
    "http://127.0.0.1:6082/vnc.html",
    `http://127.0.0.1:${BOX_PRIMARY_NOVNC_PORT}/other.html`,
  ]
  for (const value of candidates) assert.equal(proxifyBoxVncUrl(value, proxy), value)
})

test("status projections rewrite every viewer URL without changing unrelated data", () => {
  const primary = `http://127.0.0.1:${BOX_PRIMARY_NOVNC_PORT}/vnc.html`
  const original = { id: "box-1", vncUrl: primary, windows: [{ id: "window-1", vncUrl: primary }] }
  const projected = proxifyForeverBoxStatus(original, proxy)

  assert.notEqual(projected, original)
  assert.equal(projected.vncUrl, proxy.primaryUrl)
  assert.deepEqual(projected.windows?.map(window => window.vncUrl), [proxy.primaryUrl])
  assert.equal(projected.id, "box-1")
  assert.equal(original.vncUrl, primary)
  assert.equal(proxifyForeverBoxStatus(original, null), original)
})

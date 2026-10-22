import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SLATE_WEBAUTHN_SIGNER_PLATFORMS,
  slateWebauthnProxyMirroredEnablement,
  slateWebauthnSignerShips,
} from "../../source/shared/webauthn-proxy-availability.ts"

test("the signer ships only on the platforms the desktop is built for", () => {
  assert.deepEqual([...SLATE_WEBAUTHN_SIGNER_PLATFORMS], ["darwin", "win32"])
  assert.equal(slateWebauthnSignerShips("darwin"), true)
  assert.equal(slateWebauthnSignerShips("win32"), true)
  assert.equal(slateWebauthnSignerShips("linux"), false)
  assert.equal(slateWebauthnSignerShips("android"), false)
  assert.equal(slateWebauthnSignerShips("DARWIN" as never), false, "the platform name is compared as it comes")
  assert.equal(slateWebauthnSignerShips(" darwin" as never), false)
  assert.equal(slateWebauthnSignerShips(null as never), false, "only a platform name can ship a signer")
})

test("the proxy is mirrored as enabled only where the signer exists", () => {
  assert.equal(slateWebauthnProxyMirroredEnablement(true, "darwin"), true)
  assert.equal(slateWebauthnProxyMirroredEnablement(true, "win32"), true)
  assert.equal(slateWebauthnProxyMirroredEnablement(true, "linux"), false)
  assert.equal(slateWebauthnProxyMirroredEnablement(false, "darwin"), false)
  assert.equal(slateWebauthnProxyMirroredEnablement(false, "linux"), false)
  assert.equal(slateWebauthnProxyMirroredEnablement(0 as never, "darwin"), 0, "a false-y answer is passed through as it came")
  assert.equal(slateWebauthnProxyMirroredEnablement("" as never, "linux"), "", "a false-y answer is passed through as it came")
})

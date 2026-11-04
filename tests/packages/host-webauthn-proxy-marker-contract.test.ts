import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyWebAuthnProxyMarker } from "../../source/host/extensions/webauthn-proxy/webauthn-proxy-marker.ts"

test("the marker is created and removed only when the requested state changes", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-webauthn-marker-"))
  const boxRoot = join(root, "box")
  const marker = join(boxRoot, "proxy-enabled")
  mkdirSync(boxRoot)

  try {
    assert.equal(applyWebAuthnProxyMarker(true, marker, join(root, "missing-policy-command")), "applied")
    assert.equal(readFileSync(marker, "utf8"), "")

    writeFileSync(marker, "kept")
    assert.equal(applyWebAuthnProxyMarker(true, marker, join(root, "missing-policy-command")), "unchanged")
    assert.equal(readFileSync(marker, "utf8"), "kept")

    assert.equal(applyWebAuthnProxyMarker(false, marker, join(root, "missing-policy-command")), "applied")
    assert.equal(existsSync(marker), false)
    assert.equal(applyWebAuthnProxyMarker(false, marker, join(root, "missing-policy-command")), "unchanged")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

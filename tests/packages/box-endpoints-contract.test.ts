import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  BOX_FORK_NOVNC_PORT,
  BOX_IMAGE_TAG_LATEST,
  BOX_PRIMARY_NOVNC_PORT,
  BOX_SPECIAL_TREATMENT_NOVNC_PATH,
  buildBoxNoVncUrl,
  isBoxSpecialTreatmentNoVncUrl,
} from "../../source/packages/constants/box-endpoints.ts"

describe("box desktop endpoint contract", () => {
  it("keeps token values intact in the viewer and nested websockify query", () => {
    const networkToken = "network&part=two#fragment?"
    const viewerToken = "session&part=two#fragment?"
    const url = new URL(buildBoxNoVncUrl("https://box.example/boxes/one", networkToken, viewerToken, true))

    assert.equal(url.searchParams.get("network_token"), networkToken)
    assert.equal(url.pathname.endsWith(`/${BOX_SPECIAL_TREATMENT_NOVNC_PATH}`), true)
    const path = url.searchParams.get("path")
    assert.ok(path?.startsWith("websockify?"))
    const nestedPath = path ?? ""
    const nested = new URLSearchParams(nestedPath.slice(nestedPath.indexOf("?") + 1))
    assert.equal(nested.get("token"), viewerToken)
    assert.equal(nested.get("network_token"), networkToken)
    assert.equal(nested.get("resume_lower_s"), "900")
    assert.equal(nested.get("resume_upper_s"), "18000")
  })

  it("keeps endpoint identity and special-treatment detection path-based", () => {
    assert.equal(BOX_IMAGE_TAG_LATEST, "slate-box-latest")
    assert.equal(BOX_PRIMARY_NOVNC_PORT, 6080)
    assert.equal(BOX_FORK_NOVNC_PORT, 6081)
    const special = buildBoxNoVncUrl("https://box.example", "token", undefined, true)
    const standard = buildBoxNoVncUrl("https://box.example", "token")
    assert.equal(isBoxSpecialTreatmentNoVncUrl(special), true)
    assert.equal(isBoxSpecialTreatmentNoVncUrl(standard), false)
    assert.equal(isBoxSpecialTreatmentNoVncUrl("not a URL"), false)
  })
})

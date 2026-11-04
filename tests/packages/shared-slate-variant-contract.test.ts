import assert from "node:assert/strict"
import { test } from "node:test"

import { getSlateVariant, isSlateLabBuild, isSlatePackaged } from "../../source/shared/node/slate-variant.ts"

test("only the literal packaged and lab switches count, with development taking precedence", () => {
  const savedPackaged = process.env.SLATE_PACKAGED
  const savedLab = process.env.SLATE_LAB
  try {
    delete process.env.SLATE_PACKAGED
    process.env.SLATE_LAB = "1"
    assert.equal(isSlatePackaged(), false)
    assert.equal(isSlateLabBuild(), true)
    assert.equal(getSlateVariant(), "slate-dev")

    process.env.SLATE_PACKAGED = "1"
    process.env.SLATE_LAB = "true"
    assert.equal(isSlatePackaged(), true)
    assert.equal(isSlateLabBuild(), false)
    assert.equal(getSlateVariant(), "slate")

    process.env.SLATE_LAB = "1"
    assert.equal(getSlateVariant(), "slate-lab")
  } finally {
    if (savedPackaged === undefined) delete process.env.SLATE_PACKAGED
    else process.env.SLATE_PACKAGED = savedPackaged
    if (savedLab === undefined) delete process.env.SLATE_LAB
    else process.env.SLATE_LAB = savedLab
  }
})

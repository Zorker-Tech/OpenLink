import { test } from "node:test"
import assert from "node:assert/strict"

import { isKnownPluginLogoUrl, rememberPluginLogoUrl } from "../../source/shared/node/marketplace/cursor-marketplace-logo-registry.ts"

test("a logo is known once it has been shown, and every address is its own", () => {
  const logo = "https://marketplace.test/logos/one.png"
  assert.equal(isKnownPluginLogoUrl(logo), false, "a logo that has never been shown is not known")

  rememberPluginLogoUrl(logo)
  assert.equal(isKnownPluginLogoUrl(logo), true)
  rememberPluginLogoUrl(logo)
  assert.equal(isKnownPluginLogoUrl(logo), true, "remembering a logo twice does not make it two")

  assert.equal(isKnownPluginLogoUrl("https://marketplace.test/logos/two.png"), false)
  assert.equal(isKnownPluginLogoUrl(logo.toUpperCase()), false, "the address is matched as it was given")
  assert.equal(isKnownPluginLogoUrl(" " + logo), false, "whitespace is part of an address")
  assert.equal(isKnownPluginLogoUrl(logo + "/"), false)
})

test("an address that is not a URL is remembered as the value it is", () => {
  rememberPluginLogoUrl("")
  assert.equal(isKnownPluginLogoUrl(""), true, "an empty address is an address")

  rememberPluginLogoUrl("ü/文件.png")
  assert.equal(isKnownPluginLogoUrl("ü/文件.png"), true)

  rememberPluginLogoUrl(7 as never)
  assert.equal(isKnownPluginLogoUrl(7 as never), true, "a value is remembered as itself, whatever it is")
  assert.equal(isKnownPluginLogoUrl("7"), false, "and not as its text")
})

import { test } from "node:test"
import assert from "node:assert/strict"

import { isMarketplaceLogoSourceKnown, rememberMarketplaceLogoSource } from "../../source/shared/node/marketplace/marketplace-logo-registry.ts"

test("a logo is known once it has been shown, and every address is its own", () => {
  const logo = "https://marketplace.test/logos/one.png"
  assert.equal(isMarketplaceLogoSourceKnown(logo), false, "a logo that has never been shown is not known")

  rememberMarketplaceLogoSource(logo)
  assert.equal(isMarketplaceLogoSourceKnown(logo), true)
  rememberMarketplaceLogoSource(logo)
  assert.equal(isMarketplaceLogoSourceKnown(logo), true, "remembering a logo twice does not make it two")

  assert.equal(isMarketplaceLogoSourceKnown("https://marketplace.test/logos/two.png"), false)
  assert.equal(isMarketplaceLogoSourceKnown(logo.toUpperCase()), false, "the address is matched as it was given")
  assert.equal(isMarketplaceLogoSourceKnown(" " + logo), false, "whitespace is part of an address")
  assert.equal(isMarketplaceLogoSourceKnown(logo + "/"), false)
})

test("an address that is not a URL is remembered as the value it is", () => {
  rememberMarketplaceLogoSource("")
  assert.equal(isMarketplaceLogoSourceKnown(""), true, "an empty address is an address")

  rememberMarketplaceLogoSource("ü/文件.png")
  assert.equal(isMarketplaceLogoSourceKnown("ü/文件.png"), true)

  rememberMarketplaceLogoSource(7 as never)
  assert.equal(isMarketplaceLogoSourceKnown(7 as never), true, "a value is remembered as itself, whatever it is")
  assert.equal(isMarketplaceLogoSourceKnown("7"), false, "and not as its text")
})

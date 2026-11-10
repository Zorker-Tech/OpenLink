import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSlatePluginDeepLink,
  DEFAULT_SLATE_THEME_PREFERENCE,
  isSlateDeepLinkPluginId,
  isSlateThemePreference,
  SLATE_PLUGIN_DEEP_LINK_PATH,
  SLATE_THEME_PREFERENCES,
} from "../../source/shared/desktop.ts"

test("desktop theme preferences have a closed set with a stable default", () => {
  assert.deepEqual(SLATE_THEME_PREFERENCES, ["system", "light", "dark"])
  assert.equal(DEFAULT_SLATE_THEME_PREFERENCE, "system")
  assert.equal(isSlateThemePreference("dark"), true)
  assert.equal(isSlateThemePreference("solarized"), false)
  assert.equal(isSlateThemePreference(7), false)
})

test("plugin links require a decimal identifier and encode it as a query value", () => {
  assert.equal(SLATE_PLUGIN_DEEP_LINK_PATH, "/v1/plugin/add")
  assert.equal(isSlateDeepLinkPluginId("0"), true)
  assert.equal(isSlateDeepLinkPluginId("9".repeat(19)), true)
  for (const value of ["", "x", "12a", "1".repeat(20)]) assert.equal(isSlateDeepLinkPluginId(value), false)
  assert.equal(buildSlatePluginDeepLink("42"), "slate://app/v1/plugin/add?id=42")
  assert.equal(buildSlatePluginDeepLink("4 2"), "slate://app/v1/plugin/add?id=4%202")
})

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LISTENER_PLATFORMS, listenerPlatformFor } from "../../source/shared/listener-integrations.ts";

describe("the platforms an automation can listen to", () => {
  it("describes each one it can listen to, in the order a surface offers them", () => {
    assert.deepEqual(LISTENER_PLATFORMS.map((entry) => entry.platform), ["github", "slack"]);
    assert.deepEqual(LISTENER_PLATFORMS.map((entry) => entry.displayName), ["GitHub", "Slack"]);
    assert.equal(LISTENER_PLATFORMS.every((entry) => entry.blurb.length > 0), true);
  });

  it("is looked up by the platform it describes", () => {
    assert.equal(listenerPlatformFor("github")?.displayName, "GitHub");
    assert.equal(listenerPlatformFor("slack")?.displayName, "Slack");
  });

  it("answers nothing for a platform this build cannot listen to", () => {
    for (const platform of ["nope", "", "GitHub", "github ", "toString", "__proto__", "constructor"]) {
      assert.equal(listenerPlatformFor(platform), undefined, platform);
    }
  });
});

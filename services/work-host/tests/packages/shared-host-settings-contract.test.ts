import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SLATE_DISABLED_NOTIFICATION_CONFIG } from "../../source/shared/host-settings.ts";

describe("host notification defaults", () => {
  it("starts disabled and carries the bounded delivery values", () => {
    assert.deepEqual(SLATE_DISABLED_NOTIFICATION_CONFIG, {
      isEnabled: false,
      allowedApps: [],
      minIntervalMs: 5_000,
      maxPerWindow: 10,
      windowMs: 5 * 60_000,
    });
  });
});

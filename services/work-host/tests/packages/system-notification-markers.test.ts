import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SYSTEM_NOTIFICATION_CLOSE_TAG,
  SYSTEM_NOTIFICATION_OPEN_TAG,
  SYSTEM_NOTIFICATION_TAG,
} from "../../source/packages/constants/system-notification.ts";

describe("system notification markers", () => {
  it("keeps the exact persisted opening and closing delimiters", () => {
    assert.equal(SYSTEM_NOTIFICATION_TAG, "system_notification");
    assert.equal(SYSTEM_NOTIFICATION_OPEN_TAG, "<system_notification>");
    assert.equal(SYSTEM_NOTIFICATION_CLOSE_TAG, "</system_notification>");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEV_SMART_MODE_CLASSIFIER_DELAY_MS,
  DEV_SMART_MODE_CLASSIFIER_DELAY_SECONDS,
} from "../../source/packages/constants/smart-mode-classifier.ts";

describe("development classifier pause", () => {
  it("exposes the same ten-second delay in both supported units", () => {
    assert.equal(DEV_SMART_MODE_CLASSIFIER_DELAY_SECONDS, 10);
    assert.equal(DEV_SMART_MODE_CLASSIFIER_DELAY_MS, 10_000);
    assert.equal(DEV_SMART_MODE_CLASSIFIER_DELAY_MS, DEV_SMART_MODE_CLASSIFIER_DELAY_SECONDS * 1_000);
  });
});

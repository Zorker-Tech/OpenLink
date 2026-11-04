import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_HIDDEN_PROMPT_MARKER,
  SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER,
} from "../../source/host/runner/slate-prompt-markers.ts";

describe("persisted prompt markers", () => {
  it("keeps hidden and trusted-automation markers byte-for-byte stable", () => {
    assert.equal(SLATE_HIDDEN_PROMPT_MARKER, "[SLATE_HIDDEN_PROMPT]");
    assert.equal(SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER, "[SLATE_TRUSTED_AUTOMATION_PROMPT]");
  });
});

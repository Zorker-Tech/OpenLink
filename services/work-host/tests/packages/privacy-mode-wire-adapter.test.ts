import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PrivacyMode as CounterpartPrivacyMode } from "../../source/adapters/interop/proto/generated/aiserver/v1/privacy_mode_pb.ts";
import { privacyModeFromWire, privacyModeToWire } from "../../source/adapters/interop/telemetry/privacy-mode-wire-adapter.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";

describe("privacy mode wire translation", () => {
  it("maps every known account value into a Slate string category", () => {
    const cases = [
      [CounterpartPrivacyMode.UNSPECIFIED, PrivacyMode.UNSPECIFIED],
      [CounterpartPrivacyMode.NO_STORAGE, PrivacyMode.NO_STORAGE],
      [CounterpartPrivacyMode.NO_TRAINING, PrivacyMode.NO_TRAINING],
      [CounterpartPrivacyMode.USAGE_DATA_TRAINING_ALLOWED, PrivacyMode.USAGE_DATA_TRAINING_ALLOWED],
      [CounterpartPrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED, PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED],
    ] as const;

    for (const [wireValue, slateValue] of cases) {
      assert.equal(privacyModeFromWire(wireValue), slateValue);
      assert.equal(privacyModeToWire(slateValue), wireValue);
    }
    assert.equal(privacyModeFromWire(99), PrivacyMode.UNSPECIFIED);
    assert.equal(privacyModeToWire("future-mode" as never), CounterpartPrivacyMode.UNSPECIFIED);
  });
});

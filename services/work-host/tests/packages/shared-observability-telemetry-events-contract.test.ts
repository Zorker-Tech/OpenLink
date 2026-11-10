import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as events from "../../source/shared/observability/telemetry-events.ts";

describe("Slate telemetry event names", () => {
  it("uses the Slate log key for unique Slate events while keeping turn lifecycle names stable", () => {
    assert.equal(events.SLATE_LOG_KEY, "slate");
    assert.equal(events.TURN_START_EVENT, "agent.turn.start");
    assert.equal(events.TURN_OUTCOME_EVENT, "agent.turn.outcome");

    const slateEventValues = Object.entries(events)
      .filter(([name, value]) => name.endsWith("_EVENT") && typeof value === "string")
      .filter(([name]) => name !== "TURN_START_EVENT" && name !== "TURN_OUTCOME_EVENT")
      .map(([, value]) => value as string);

    assert.equal(slateEventValues.every(value => value.startsWith(`${events.SLATE_LOG_KEY}.`)), true);
    assert.equal(new Set(slateEventValues).size, slateEventValues.length);
    assert.equal(events.TELEMETRY_DROPPED_EVENT, "slate.telemetry.dropped");
    assert.equal(events.TELEMETRY_SHIP_TIMEOUT_EVENT, "slate.telemetry.ship_timeout");
  });

  it("keeps the dropped-report reason order and the measurement unit for each reason", () => {
    assert.deepEqual([...events.TELEMETRY_DROP_REASONS], [
      "ship_failed",
      "overflow_evicted",
      "replay_expired",
      "backend_dropped",
      "account_rotated",
    ]);
    assert.deepEqual(events.TELEMETRY_DROP_UNIT_BY_REASON, {
      ship_failed: "attempts",
      overflow_evicted: "entries",
      replay_expired: "entries",
      backend_dropped: "entries",
      account_rotated: "entries",
    });
  });

  it("keeps the WebAuthn signing failure vocabulary in its published order", () => {
    assert.deepEqual([...events.WEBAUTHN_SIGN_ERROR_CLASSES], [
      "no_credentials",
      "pin_not_set",
      "pin_blocked",
      "pin_other",
      "cancelled_or_timeout",
      "unsupported_option",
      "hid_error",
      "ambiguous_credential",
      "bad_options",
      "create_unsupported",
      "platform_api",
      "signer_other",
      "helper_spawn_failed",
      "helper_no_result",
    ]);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { GetUserPrivacyModeRequest } from "../../source/adapters/interop/proto/generated/aiserver/v1/dashboard_pb.ts";
import { PrivacyMode as CounterpartPrivacyMode } from "../../source/adapters/interop/proto/generated/aiserver/v1/privacy_mode_pb.ts";
import { readSlatePrivacyModeFromDashboard } from "../../source/adapters/interop/telemetry/privacy-mode-dashboard-adapter.ts";
import { PrivacyMode as SlatePrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";

test("the privacy-mode adapter builds the request and maps every known wire value", async () => {
  const signal = new AbortController().signal;
  const calls: Array<{ request: GetUserPrivacyModeRequest; signal: AbortSignal }> = [];
  const mappings = [
    [CounterpartPrivacyMode.UNSPECIFIED, SlatePrivacyMode.UNSPECIFIED],
    [CounterpartPrivacyMode.NO_STORAGE, SlatePrivacyMode.NO_STORAGE],
    [CounterpartPrivacyMode.NO_TRAINING, SlatePrivacyMode.NO_TRAINING],
    [CounterpartPrivacyMode.USAGE_DATA_TRAINING_ALLOWED, SlatePrivacyMode.USAGE_DATA_TRAINING_ALLOWED],
    [CounterpartPrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED, SlatePrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED],
    [99, SlatePrivacyMode.UNSPECIFIED],
  ] as const;

  for (const [wireValue, slateValue] of mappings) {
    const value = await readSlatePrivacyModeFromDashboard({
      async getUserPrivacyMode(request: GetUserPrivacyModeRequest, options: { signal: AbortSignal }) {
        calls.push({ request, signal: options.signal });
        return { privacyMode: wireValue } as never;
      },
    }, { signal });
    assert.equal(value, slateValue);
  }

  assert.equal(calls.length, mappings.length);
  for (const call of calls) {
    assert.equal(call.request instanceof GetUserPrivacyModeRequest, true);
    assert.equal(call.request.inferredPrivacyMode, CounterpartPrivacyMode.NO_STORAGE);
    assert.equal(call.signal, signal);
  }
})

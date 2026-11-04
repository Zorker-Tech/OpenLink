import assert from "node:assert/strict";
import { test } from "node:test";

import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { adaptSubscriptionWakeup } from "../../source/adapters/interop/agent/subscription-notification-action-adapter.ts";

test("subscription wakeups preserve message order and adjacent request context", () => {
  const requestContext = { source: "timer" };
  const listener = { send() {} };
  const adapted = adaptSubscriptionWakeup({
    _privacyMode: PrivacyMode.UNSPECIFIED,
    notifications: [{ index: 1 }, { index: 2 }, { index: 3 }],
    requestContext,
    sendToInteractionListener: listener,
  });
  const action = adapted.userMessageAction as {
    readonly userMessage: unknown;
    readonly prependUserMessages: readonly unknown[];
    readonly requestContext: unknown;
    readonly sendToInteractionListener: unknown;
    readonly _privacyMode: unknown;
  };
  assert.equal(adapted.notificationCount, 3);
  assert.deepEqual(action.userMessage, { index: 3 });
  assert.deepEqual(action.prependUserMessages, [{ index: 1 }, { index: 2 }]);
  assert.equal(action.requestContext, requestContext);
  assert.equal(action.sendToInteractionListener, listener);
  assert.equal(action._privacyMode, PrivacyMode.UNSPECIFIED);
});

test("an empty subscription event has no user-message conversion", () => {
  assert.throws(() => adaptSubscriptionWakeup({ _privacyMode: PrivacyMode.UNSPECIFIED, notifications: [] }), /requires at least one notification/);
});

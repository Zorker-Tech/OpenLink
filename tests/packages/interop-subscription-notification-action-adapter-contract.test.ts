import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationAction, SubscriptionNotificationAction, UserMessage } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { RequestContext } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts";
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts";
import { SlateAgentActionKind } from "../../source/packages/agent/agent-action-state.ts";
import {
  createSlateSubscriptionNotificationActionPayload,
  isSlateSubscriptionNotificationActionPayload,
  subscriptionNotificationAsUserMessageAction,
} from "../../source/packages/agent/actions/subscription-notification-contracts.ts";
import { slateAgentActionFromInterop } from "../../source/adapters/interop/agent/turn-agent-run-projection-adapter.ts";

test("subscription notifications project into an ordered Slate batch and user-message action", () => {
  const historicalAction = new ConversationAction({
    action: {
      case: "subscriptionNotificationAction",
      value: new SubscriptionNotificationAction({
        notifications: [
          new UserMessage({ text: "first", messageId: "notice-1" }),
          new UserMessage({ text: "second", messageId: "notice-2" }),
          new UserMessage({ text: "latest", messageId: "notice-3" }),
        ],
        requestContext: new RequestContext({}),
        sendToInteractionListener: true,
      }),
    },
  });
  const action = slateAgentActionFromInterop(historicalAction, PrivacyMode.UNSPECIFIED);
  const payload = action.payload as ReturnType<typeof createSlateSubscriptionNotificationActionPayload>;

  assert.equal(action.kind, SlateAgentActionKind.SUBSCRIPTION_NOTIFICATION);
  assert.equal(isSlateSubscriptionNotificationActionPayload(payload), true);
  assert.equal(payload.schema, "slate.agent-action.subscription-notification");
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.notifications.map(message => message.messageId), ["notice-1", "notice-2", "notice-3"]);
  assert.equal(payload.notifyUser, true);
  assert.ok(payload.compatibility?.requestContext);
  assert.ok(payload.compatibility?.legacyPayload);

  const userMessageAction = subscriptionNotificationAsUserMessageAction(payload);
  assert.equal(userMessageAction.schema, "slate.agent-action.user-message");
  assert.equal(userMessageAction.message?.messageId, "notice-3");
  assert.deepEqual(userMessageAction.earlierMessages.map(message => message.messageId), ["notice-1", "notice-2"]);
  assert.equal(userMessageAction.notifyUser, true);
  assert.equal(userMessageAction.compatibility?.requestContext, payload.compatibility?.requestContext);
  const latestText = userMessageAction.message?.text;
  assert.ok(latestText !== undefined);
  assert.equal(
    isRedactedString(latestText) ? latestText.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : latestText,
    "latest",
  );
});

test("an empty subscription event is refused before starting a user turn", () => {
  const payload = createSlateSubscriptionNotificationActionPayload({ notifications: [], notifyUser: false });
  assert.throws(() => subscriptionNotificationAsUserMessageAction(payload), /requires at least one notification/);
});

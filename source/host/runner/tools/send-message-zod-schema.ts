import { z } from "zod";

import { SEND_MESSAGE_TYPE_DESCRIPTION, SEND_MESSAGE_TYPES } from "./send-message-schema-contracts.ts";
import { refineSendMessage } from "./send-message-refinement.ts";
import {
  attachmentAltField,
  channelField,
  contentField,
  imageField,
  replyAddressField,
  secretRequestField,
  slateAgentIdField,
  urlField,
  widgetField,
} from "./send-message-zod-fields.ts";

const messageObject = z.object({
  type: z.enum(SEND_MESSAGE_TYPES).describe(SEND_MESSAGE_TYPE_DESCRIPTION),
  content: contentField,
  url: urlField,
  images: imageField,
  alt: attachmentAltField,
  reply_to: replyAddressField,
  channel: channelField,
  widget: widgetField,
  bcId: slateAgentIdField,
  secret: secretRequestField,
});

export const sendMessageParameters = messageObject.superRefine((candidate, context) => {
  for (const issue of refineSendMessage(candidate)) {
    context.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
  }
});

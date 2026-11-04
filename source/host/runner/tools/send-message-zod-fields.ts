import { z } from "zod";

import { slateWidgetSchema } from "../../../shared/slate-widgets.ts";

export const contentField = z.string().trim().optional().describe("Required when type is text. The message to show to the user.");
export const urlField = z.string().trim().optional().describe("Required when type is attachment. Use file:// for local files or https:// for remote files and standalone media.");
export const imageField = z.array(z.object({
  url: z.string().trim().min(1).describe("file:// or https:// URL of the image."),
  alt: z.string().trim().optional().describe("Optional short description of this image, shown on hover and as its fullscreen caption."),
})).optional().describe("Optional, only for type:text. Image(s) that belong with this message; they render inside the same chat bubble, below your text — one image full width, several as a compact gallery. Use whenever you're showing something you're talking about; use type:attachment only for an image that IS the whole message.");
export const attachmentAltField = z.string().trim().optional().describe("Optional. A short description (alt text) of the image for type:attachment — what the image shows. Shown to the user on hover and in the fullscreen viewer.");
export const replyAddressField = z.string().trim().optional().describe("Optional. Short address of the prior message this reply threads to (e.g. t3u for the user message in turn 3, t3s1 for your second SendMessage in turn 3). Omit when not threading.");
export const channelField = z.string().trim().optional().describe("Optional. A connected messaging channel address to deliver this to instead of the in-app Slate chat, shaped platform:chat, the address shown to you in an [inbound] wake. Omit to send to the in-app chat (the default). Only valid with type:text or type:attachment.");
export const widgetField = slateWidgetSchema.optional().describe("Required when type is widget. A question with selectable options: { prompt, helpText?, options: [{ label, value?, description?, style? }], allowCustom?, dismissOnMoveOn? }. The user picks one option; its value comes back as their reply, and the chat shows the resolved card with their selection checked under your prompt — so phrase the prompt as a natural question, not a menu instruction. The user can also dismiss the question without answering; you'll be told on your next turn, so treat that as a decline and don't re-ask. Set allowCustom: true to also let the user type their own free-text answer instead of picking an option. Set dismissOnMoveOn: true only for low-stakes questions that become moot if the user moves on (it auto-dismisses once they send a newer message without answering); leave it off for real decisions you still need answered.");
export const slateAgentIdField = z.string().trim().optional().describe("Required when type is slate-agent. The bcId of the Slate cloud agent to reference (e.g. bc-xxxxxxxx-...).");
export const secretRequestField = z.object({
  label: z.string().trim().min(1).describe('What credential to ask for, shown as the card title and echoed in the field placeholder ("Paste your …"), e.g. "Slack bot token".'),
  description: z.string().trim().optional().describe("Optional short help shown under the label."),
  connector: z.string().trim().min(1).describe("The connector/platform the secret is for. The value is written to that connector's per-agent credential file."),
  field: z.string().trim().min(1).describe('The credential field name to store the value under, e.g. "token".'),
}).optional().describe("Required when type is secret-request. Asks the user for a credential through a masked secure input; the value goes straight to the connector's credential file and never reaches you or the chat. You only learn that it was provided.");

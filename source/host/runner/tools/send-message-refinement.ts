import { isFieldProvided, isValidAttachmentUrl, TYPE_FIELD_RULES } from "./send-message-field-policy.ts";
import type { SendMessageInput, SendMessageIssue } from "./send-message-schema-contracts.ts";

export function refineSendMessage(candidate: SendMessageInput): SendMessageIssue[] {
  const issues: SendMessageIssue[] = [];
  for (const rule of TYPE_FIELD_RULES) {
    const propertyName = rule.field;
    const acceptedTypes = rule.acceptedTypes;
    if (acceptedTypes.includes(candidate.type) || !isFieldProvided(candidate[propertyName])) continue;
    const acceptedLabels = acceptedTypes.map((type) => `type:${type}`).join(" or ");
    issues.push({
      path: [String(propertyName)],
      message: `${String(propertyName)} is only valid with ${acceptedLabels} and cannot ride a type:${candidate.type} message — it would be silently dropped. Nothing was sent. Re-send as separate SendMessage calls, one per type: this field on its own properly-typed message (${acceptedLabels}), and any text as its own type:text message.`,
    });
  }

  if (candidate.channel && candidate.type !== "text" && candidate.type !== "attachment") {
    issues.push({ path: ["channel"], message: "channel can only be set for type:text or type:attachment, not widgets or slate-agent cards" });
  }
  if ((candidate.images?.length ?? 0) > 0 && candidate.type !== "text") {
    issues.push({ path: ["images"], message: "images can only be set for type:text (they attach to a text message); for a standalone attachment use type:attachment with url" });
  }

  if (candidate.type === "text") {
    if (!candidate.content) issues.push({ path: ["content"], message: "content is required when type is text" });
    for (const [index, image] of (candidate.images ?? []).entries()) {
      if (!isValidAttachmentUrl(image.url)) {
        issues.push({ path: ["images", index, "url"], message: "each images url must include a file:// or https:// scheme" });
      }
    }
  } else if (candidate.type === "attachment") {
    if (!candidate.url) issues.push({ path: ["url"], message: "url is required when type is attachment" });
    else if (!isValidAttachmentUrl(candidate.url)) {
      issues.push({ path: ["url"], message: "url must include a file:// or https:// scheme when type is attachment" });
    }
  }
  return issues;
}

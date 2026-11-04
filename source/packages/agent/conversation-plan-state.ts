/** Slate's active plan, before the historical blob representation. */
import { PrivacyCapability } from "../redaction/classification.ts"

export interface SlateConversationPlanState {
  readonly content: string
}

interface RedactedTextValue {
  unwrap(purpose: PrivacyCapability, options?: object): string
}

function isRedactedTextValue(value: unknown): value is RedactedTextValue {
  return value !== null &&
    typeof value === "object" &&
    "unwrap" in value &&
    typeof value.unwrap === "function"
}

/**
 * Projects a decoded plan into Slate's model.
 *
 * Incoming plan actions and historical checkpoints use the same narrow shape: a plan string,
 * optionally wrapped with its privacy classification. The runtime policy receives only text.
 */
export function slateConversationPlanFromValue(value: unknown): SlateConversationPlanState {
  if (typeof value === "string") return { content: value }
  if (value === null || typeof value !== "object") {
    throw new TypeError("conversation plan must contain text")
  }

  const record = value as {
    readonly content?: unknown
    readonly plan?: unknown
  }
  if (typeof record.content === "string") return { content: record.content }
  if (typeof record.plan === "string") return { content: record.plan }
  if (isRedactedTextValue(record.plan)) {
    return { content: record.plan.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) }
  }
  throw new TypeError("conversation plan must contain text")
}

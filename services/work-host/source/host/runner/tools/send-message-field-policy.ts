import type { SendMessageInput, SendMessageType } from "./send-message-schema-contracts.ts";

export interface SendMessageFieldRule {
  readonly field: keyof SendMessageInput;
  readonly acceptedTypes: readonly SendMessageType[];
}

export const TYPE_FIELD_RULES: readonly SendMessageFieldRule[] = [
  { field: "content", acceptedTypes: ["text"] },
  { field: "url", acceptedTypes: ["attachment"] },
  { field: "alt", acceptedTypes: ["attachment"] },
  { field: "widget", acceptedTypes: ["widget"] },
  { field: "agentId", acceptedTypes: ["slate-agent"] },
  { field: "secret", acceptedTypes: ["secret-request"] },
];

export function isValidAttachmentUrl(urlCandidate: string): boolean {
  try {
    const protocol = new URL(urlCandidate).protocol;
    return protocol === "file:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isFieldProvided(candidate: unknown): boolean {
  if (candidate == null) return false;
  if (typeof candidate === "string") return candidate.length > 0;
  return !Array.isArray(candidate) || candidate.length > 0;
}

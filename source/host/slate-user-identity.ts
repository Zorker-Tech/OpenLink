import { clampLine } from "../shared/slate-text.ts";

export const MAX_FULL_NAME_LENGTH = 200;

export function normalizeSlateUserFullName(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const displayName = clampLine(raw, MAX_FULL_NAME_LENGTH);
  return displayName.length > 0 ? displayName : undefined;
}

function actingAsUserInstruction(displayName: string): string {
  return `You are acting for ${displayName}. In their accounts and apps, write from their perspective; do not describe them as an outside person.`;
}

export function renderUserIdentitySystemPrompt(fullName: string | null | undefined): string {
  const displayName = normalizeSlateUserFullName(fullName);
  return displayName === undefined ? "" : actingAsUserInstruction(displayName);
}

/**
 * Who the user is, as the agent is told it.
 *
 * A name is bounded and a name that says nothing is not one; what the agent is told is that the accounts and apps it
 * acts through are the user's, so it speaks as them rather than about them.
 */
import { clampLine } from "../shared/slate-text.ts";
export const MAX_FULL_NAME_LENGTH = 200;
export function normalizeSlateUserFullName(raw: string | null | undefined): string | undefined { if (raw == null) return undefined; const clamped = clampLine(raw, MAX_FULL_NAME_LENGTH); return clamped.length > 0 ? clamped : undefined; }
export function renderUserIdentitySystemPrompt(fullName: string | null | undefined): string { const name = normalizeSlateUserFullName(fullName); return name == null ? "" : `Your user is ${name}; when acting through their accounts and apps, such as Slack, speak as them and never refer to them in the third person.`; }

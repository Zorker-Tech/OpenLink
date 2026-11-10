/**
 * The short identifiers the prompt uses to refer to a message or a tool call.
 *
 * A full message id is long and carries no meaning for the model, so it is replaced by seven characters
 * derived from it: the same message always gets the same reference, and the reference is short enough to
 * appear in a prompt without competing with the content. A tool call already carries a reference-sized
 * suffix, so that suffix is used when it is one, and the id itself when it is not.
 *
 * The tag that carries the reference is stripped again when the message is read back, which is what makes
 * the reference invisible to everything except the prompt: both the tag as it is written today and the
 * form it was written in before are recognized.
 */

import { createHash, randomInt } from "node:crypto";

/** How many characters a reference is, and what it may be made of. */
export const PROMPT_REFERENCE_ID_LENGTH = 7;
export const PROMPT_REFERENCE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const ALPHABET_LENGTH = PROMPT_REFERENCE_ID_ALPHABET.length;

/** A reference as a pattern body: exactly this many characters of the alphabet. */
const REFERENCE_PATTERN = `[A-Za-z0-9]{${PROMPT_REFERENCE_ID_LENGTH}}`;

/** The tag a user message's reference is carried in, and the tag a tool call's is. */
const USER_TAG = { open: "<user_message_id>", close: "</user_message_id>" } as const;
const TOOL_TAG = { open: "<tool_call_id>", close: "</tool_call_id>" } as const;

const REFERENCE_ID = new RegExp(`^${REFERENCE_PATTERN}$`);
const LEADING_USER_TAG = new RegExp(`^${USER_TAG.open}\\s*(${REFERENCE_PATTERN})\\s*${USER_TAG.close}\\n?`);
const LEADING_USER_TAG_LEGACY = new RegExp(`^${USER_TAG.open}\\s*message_id=(${REFERENCE_PATTERN})\\s*${USER_TAG.close}\\n?`);

/** Seven characters of the alphabet, taken from these bytes. */
function referenceFrom(bytes: ArrayLike<number>): string {
  let id = "";
  for (let index = 0; index < PROMPT_REFERENCE_ID_LENGTH; index += 1) {
    id += PROMPT_REFERENCE_ID_ALPHABET[(bytes[index] as number) % ALPHABET_LENGTH];
  }
  return id;
}

/** The reference a message id always gets: derived rather than random, so the same message always has the same one. */
export function createPromptReferenceIdFromMessageId(messageId: string): string {
  return referenceFrom(createHash("sha256").update(messageId).digest());
}

/** A reference for this message, or a fresh one when there is no id to derive it from. */
export function createPromptReferenceId(messageId?: string | null): string {
  const normalized = messageId?.trim();
  if (normalized !== undefined && normalized.length > 0) return createPromptReferenceIdFromMessageId(normalized);
  const bytes: number[] = [];
  for (let index = 0; index < PROMPT_REFERENCE_ID_LENGTH; index += 1) bytes.push(randomInt(0, ALPHABET_LENGTH));
  return referenceFrom(bytes);
}

export function isValidPromptReferenceId(id: string): boolean {
  return REFERENCE_ID.test(id);
}

/** A reference in its tag, as a prompt carries it. */
function tagged(tag: { readonly open: string; readonly close: string }, id: string): string {
  return `${tag.open}${id}${tag.close}`;
}

export function renderUserMessageIdTag(id: string): string {
  return tagged(USER_TAG, id);
}

/** The reference a tool call already carries, when its id ends in one, and the id itself when it does not. */
export function createToolCallReferenceId(toolCallId: string): string {
  const normalized = toolCallId.trim();
  if (normalized.length === 0) return "";
  const separator = normalized.lastIndexOf("_");
  if (separator < 0) return normalized;
  const suffix = normalized.slice(separator + 1);
  if (suffix.length < PROMPT_REFERENCE_ID_LENGTH) return normalized;
  const candidate = suffix.slice(0, PROMPT_REFERENCE_ID_LENGTH);
  return isValidPromptReferenceId(candidate) ? candidate : normalized;
}

export function renderToolCallIdTag(id: string): string {
  return tagged(TOOL_TAG, id);
}

/** The reference a message's text opens with, and the text without that tag — in either spelling the tag has had. */
export function parseLeadingUserMessageIdTag(text: string): { id: string; strippedText: string } | undefined {
  const match = LEADING_USER_TAG.exec(text) ?? LEADING_USER_TAG_LEGACY.exec(text);
  if (match === null) return undefined;
  const id = match[1];
  return id === undefined ? undefined : { id, strippedText: text.slice(match[0].length) };
}

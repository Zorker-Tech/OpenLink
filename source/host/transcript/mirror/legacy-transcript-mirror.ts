/**
 * The file mirror a conversation's transcript is written through.
 *
 * A checkpoint that moves the transcript forward is written incrementally, from what the state says the transcript
 * already held; a checkpoint that does not is written in full, from the state itself. What the state carries as blobs
 * (prompt messages, summaries) is decoded as it is written, so the files hold what was said rather than what it was
 * stored as.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TranscriptStore } from "../agent-transcript/index.ts";
import { stripContextTags } from "../agent-transcript/context-stripping.ts";
import { getSafeConversationId } from "../../../packages/utils/conversation-paths.ts";
import type { TranscriptCheckpoint } from "./transcript-journal-codec.ts";

export class UnexpectedIncrementalFullWriteError extends Error {
  override name = "UnexpectedIncrementalFullWriteError";
}

export interface LegacyTranscriptState extends TranscriptCheckpoint {
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly summaryArchives: readonly Uint8Array[];
}

export interface LegacyTranscriptBlobStore {
  getBlob(ctx: unknown, id: Uint8Array): Promise<Uint8Array | undefined>;
}

interface CoreMessage {
  readonly role: string;
  readonly content?: string | readonly CoreMessagePart[];
  readonly providerOptions?: {
    readonly slate?: { readonly isSummary?: boolean };
  };
}

type CoreMessagePart =
  | { readonly type: "text" | "reasoning"; readonly text: string }
  | { readonly type: "redacted-reasoning" }
  | { readonly type: "image" }
  | { readonly type: "file"; readonly filename?: string }
  | { readonly type: "tool-call"; readonly toolName: string; readonly args?: unknown }
  | { readonly type: "tool-result"; readonly toolName: string }
  | { readonly type: string; readonly [key: string]: unknown };

interface JsonMessage {
  role: string;
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ toolName: string; args: unknown }>;
  toolResult?: { toolName: string };
}

export const OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES = 5_000_000;

/** Whether an incremental write from this state still continues the transcript it was given. */
function incrementalCarries(state: LegacyTranscriptState, previousRootPromptCount: number): boolean {
  return previousRootPromptCount !== 0 && state.rootPromptMessagesJson.length >= previousRootPromptCount;
}

/** The writer an incremental mirror refuses to fall back to. */
function refuseFullWrite(): (filePath: string, content: string) => Promise<void> {
  return async () => {
    throw new UnexpectedIncrementalFullWriteError("incremental transcript mirror attempted a full write");
  };
}

/** Whether a written line is a metadata or turn-ended marker rather than a message. */
function isMarkerLine(line: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line.trim());
  } catch {
    return false;
  }
  return typeof value === "object" && value != null && "type" in value && (value.type === "metadata" || value.type === "turn_ended");
}

export function countTranscriptMessageLines(jsonl: string): number {
  return jsonl.split("\n").filter((line) => line.trim().length > 0 && !isMarkerLine(line)).length;
}






function isSummaryMessage(message: CoreMessage): boolean {
  return message.providerOptions?.slate?.isSummary === true;
}






/** The tags a hidden-thinking block can be written in. */
const HIDDEN_THINKING_PATTERNS = [/<think>[\s\S]*?<\/think>/gi, /<thinking>[\s\S]*?<\/thinking>/gi]

function stripHiddenThinkingTags(text: string): string {
  return HIDDEN_THINKING_PATTERNS.reduce((current, pattern) => current.replace(pattern, ""), text).replace(/\n{3,}/g, "\n\n").trim();
}


/** Whether a full write can be said to have happened: a file was written, or there was nothing to write. */
function fullWriteHappened(completed: boolean, wroteFile: boolean, state: LegacyTranscriptState): boolean {
  return completed && (wroteFile || (state.summaryArchives.length === 0 && state.rootPromptMessagesJson.length === 0));
}



/** Whether the transcript on disk already holds more message lines than this content would. */
async function existingTranscriptIsLonger(filePath: string, content: string): Promise<boolean> {
  let existing: string | null
  try {
    existing = await readFile(filePath, "utf8")
  } catch {
    return false
  }
  return existing != null && countTranscriptMessageLines(content) < countTranscriptMessageLines(existing)
}

/** The text of one message, with the context tags and hidden thinking a reader should not see removed. */
function visibleText(text: string, role: string, stripTags: boolean): string {
  const processed = stripTags ? stripContextTags(text) : text
  return role === "assistant" ? stripHiddenThinkingTags(processed) : processed
}

/** The message as it is said: its visible text, when there is any. */
function withVisibleText(json: JsonMessage, content: string, role: string, stripTags: boolean): JsonMessage {
  const visible = visibleText(content, role, stripTags);
  if (visible.trim()) json.text = visible;
  return json;
}

/** What one part of a message is, in the transcript's own terms. */
function textOfPart(part: { readonly text: string }, role: string, stripTags: boolean): string | undefined {
  const visible = visibleText(part.text, role, stripTags)
  return visible.trim() ? visible : undefined
}

/** A thinking part as text, with redacted reasoning said so. */
function thinkingOfPart(part: { readonly type: string; readonly text?: string }): string | undefined {
  if (part.type === "redacted-reasoning") return "[REDACTED]"
  const text = part.text ?? ""
  return text.trim() ? text : undefined
}

/** The words a part that has no text is rendered as. */
function placeholderOfPart(part: { readonly type: string; readonly filename?: string }): string {
  if (part.type === "image") return "[Image]"
  return part.filename ? `[File: ${part.filename}]` : "[File]"
}

function formatMessageToJson(message: CoreMessage, stripTags: boolean): JsonMessage {
  const json: JsonMessage = { role: message.role }
  const content = message.content
  if (typeof content === "string") return withVisibleText(json, content, message.role, stripTags)
  if (!Array.isArray(content)) return json
  return withPartsSummary(json, summarizeParts(content, message.role, stripTags))
}

/** The message with what its parts said put on it. */
function withPartsSummary(json: JsonMessage, summary: ReturnType<typeof summarizeParts>): JsonMessage {
  if (summary.textParts.length > 0) json.text = summary.textParts.join("\n")
  if (summary.thinkingParts.length > 0) json.thinking = summary.thinkingParts.join("\n")
  if (summary.toolCalls.length > 0) json.toolCalls = summary.toolCalls
  if (summary.toolResult != null) json.toolResult = summary.toolResult
  return json
}

/** What the parts of a message say, gathered in one pass. */
function summarizeParts(content: readonly CoreMessagePart[], role: string, stripTags: boolean): { textParts: string[]; thinkingParts: string[]; toolCalls: Array<{ toolName: string; args: unknown }>; toolResult: { toolName: string } | undefined } {
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls: Array<{ toolName: string; args: unknown }> = []
  let toolResult: { toolName: string } | undefined
  for (const part of content) {
    switch (part.type) {
      case "text": {
        const text = textOfPart(part as { readonly text: string }, role, stripTags)
        if (text !== undefined) textParts.push(text)
        break
      }
      case "reasoning":
      case "redacted-reasoning": {
        const thinking = thinkingOfPart(part as { readonly type: string; readonly text?: string })
        if (thinking !== undefined) thinkingParts.push(thinking)
        break
      }
      case "image":
      case "file":
        textParts.push(placeholderOfPart(part as { readonly type: string; readonly filename?: string }))
        break
      case "tool-call":
        toolCalls.push({ toolName: (part as { readonly toolName: string }).toolName, args: (part as { readonly args?: unknown }).args })
        break
      case "tool-result":
        toolResult = { toolName: (part as { readonly toolName: string }).toolName }
        break
    }
  }
  return { textParts, thinkingParts, toolCalls, toolResult }
}

/** The content blocks one formatted message becomes in the transcript: its text, then its tool calls. */
function contentBlocksFor(json: JsonMessage): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  const textParts: string[] = []
  if (json.text != null) textParts.push(json.text)
  if (json.thinking != null) textParts.push(json.thinking)
  if (textParts.length > 0) content.push({ type: "text", text: textParts.join("\n\n") })
  for (const call of json.toolCalls ?? []) content.push({ type: "tool_use", name: call.toolName, input: call.args })
  return content
}

/** Whether a message is one the transcript records at all. */
function isMirroredMessage(message: CoreMessage): boolean {
  return message.role !== "system" && !isSummaryMessage(message);
}

export function formatSingleMessageJsonl(message: CoreMessage): string | undefined {
  if (!isMirroredMessage(message)) return undefined
  const json = formatMessageToJson(message, message.role === "user")
  const content = contentBlocksFor(json)
  if (content.length === 0) return undefined
  return JSON.stringify({ role: message.role, message: { content } })
}


/** Whether a transcript would open with two user lines, which it must not. */
function startsWithTwoUsers(messages: readonly CoreMessage[]): boolean {
  return messages.length >= 2 && messages[0]?.role === "user" && messages[1]?.role === "user";
}



export class LegacyFileTranscriptMirror {
  constructor(readonly transcriptsDir: string) {}

  jsonlPathFor(conversationId: string): string {
    return this.storePathFor(conversationId, "jsonl");
  }

  private storePathFor(conversationId: string, ext: string): string {
    const safeId = getSafeConversationId(conversationId);
    return join(this.transcriptsDir, safeId, `${safeId}.${ext}`);
  }

  async writeIncremental(
    ctx: unknown,
    conversationId: string,
    state: LegacyTranscriptState,
    blobStore: LegacyTranscriptBlobStore,
    previousRootPromptCount: number
  ): Promise<number | null> {
    if (!incrementalCarries(state, previousRootPromptCount)) return null;
    const writtenCount = await this.transcriptStore(blobStore, refuseFullWrite()).writeFromStateIncremental(
      ctx as Parameters<TranscriptStore["writeFromStateIncremental"]>[0],
      state,
      conversationId,
      previousRootPromptCount,
    );
    return writtenCount === 0 ? null : writtenCount;
  }

  async writeFull(
    ctx: unknown,
    conversationId: string,
    state: LegacyTranscriptState,
    blobStore: LegacyTranscriptBlobStore
  ): Promise<boolean> {
    let wroteFile = false;
    const store = this.transcriptStore(blobStore, async (filePath, content) => {
      wroteFile = (await this.writeFullTranscriptFile(filePath, content, conversationId)) || wroteFile;
    });
    const completed = await store.writeFromStateFull(
      ctx as Parameters<TranscriptStore["writeFromStateFull"]>[0],
      state,
      conversationId,
    );
    return fullWriteHappened(completed, wroteFile, state);
  }

  /** Writes one transcript file unless the file already holds more message lines; says whether it wrote. */
  private async writeFullTranscriptFile(filePath: string, content: string, conversationId: string): Promise<boolean> {
    await mkdir(dirname(filePath), { recursive: true });
    if (filePath === this.jsonlPathFor(conversationId) && await existingTranscriptIsLonger(filePath, content)) return false;
    await writeFile(filePath, content, "utf8");
    return true;
  }

  private transcriptStore(
    blobStore: LegacyTranscriptBlobStore,
    writeTranscript: (filePath: string, content: string) => Promise<void>,
  ): TranscriptStore {
    return new TranscriptStore(this.transcriptsDir, blobStore, writeTranscript, this.storeOptions());
  }

  /** The options every legacy mirror store is opened with. */
  private storeOptions() {
    return {
      writeText: false,
      writeJsonl: true,
      appendFile: async (filePath: string, content: string) => {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, content, "utf8");
      },
      fallbackToFullWriteOnIncrementalFailure: false,
      pathResolver: (conversationId: string, ext: string) => this.storePathFor(conversationId, ext),
    };
  }
}

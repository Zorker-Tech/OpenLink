/**
 * Where an entry stands in a conversation, worked out from what is there.
 *
 * A checkpoint lists the turns a transcript currently holds. The deriver reads those turns and their steps into the
 * lines a reader should see — the user's words, what the agent said, and each tool call with what it was given and what
 * came back — while refusing a checkpoint whose recorded past no longer matches what was written: a turn that changed
 * kind, a user message that was edited, steps that moved backwards, a tool call that changed after it was recorded.
 *
 * A turn still being written holds its last text back for the next checkpoint, so a line is never derived from words
 * that may still change; the deferred step is handed back to the caller and re-derived once the turn is finished.
 */
import { stripContextTags } from "../agent-transcript/context-stripping.ts";
import {
  bytesEqual,
  formatToolLine,
  TranscriptJournalCorruptionError,
  type DeferredTranscriptStep,
  type TranscriptCheckpoint,
} from "./transcript-journal-codec.ts";
import type {
  TranscriptDeriver,
  TranscriptOccurrence,
} from "./transcript-mirror.ts";

/** Where blob bytes come from while a checkpoint is being read. */
export interface TranscriptOccurrenceBlobStore {
  getBlob(scope: unknown, id: Uint8Array): Promise<Uint8Array | undefined>;
}

/** One turn as it was decoded from the transcript journal. */
export type DecodedTranscriptTurn =
  | { readonly case: "agent"; readonly userMessage: Uint8Array; readonly steps: readonly Uint8Array[] }
  | { readonly case: "shell" }
  | { readonly case: undefined };

/** One step as it was decoded from the transcript journal. */
export type DecodedTranscriptStep =
  | { readonly case: "assistant" | "thinking"; readonly text: string }
  | { readonly case: "tool"; readonly name: string; readonly input: unknown; readonly result?: unknown }
  | { readonly case: undefined };

/**
 * Generated protobuf decoding remains a mandatory production input. The emitted deriver consumes
 * ConversationTurnStructure, UserMessage and ConversationStep and relies on generated `toJson()` for tool payloads.
 */
export interface TranscriptOccurrenceCodec {
  decodeTurn(bytes: Uint8Array): DecodedTranscriptTurn;
  decodeUserMessage(bytes: Uint8Array): { readonly text: string; readonly textBlobId?: Uint8Array };
  decodeStep(bytes: Uint8Array): DecodedTranscriptStep;
}

/** The refusal for a checkpoint that cannot be derived from, or that contradicts its own recorded past. */
function corruption(message: string): TranscriptJournalCorruptionError {
  return new TranscriptJournalCorruptionError(message);
}

/** One blob, or a corruption refusal naming what was missing. */
async function requiredBlob(
  scope: unknown,
  blobs: TranscriptOccurrenceBlobStore,
  id: Uint8Array,
  what: string,
): Promise<Uint8Array> {
  const blob = await blobs.getBlob(scope, id);
  if (blob == null) throw corruption(`missing ${what} blob while deriving transcript checkpoint`);
  return blob;
}

/** A turn decoded from one of the checkpoint's blobs. */
async function readTurn(
  codec: TranscriptOccurrenceCodec,
  scope: unknown,
  blobs: TranscriptOccurrenceBlobStore,
  id: Uint8Array,
  what: string,
): Promise<DecodedTranscriptTurn> {
  return codec.decodeTurn(await requiredBlob(scope, blobs, id, what));
}

/** A step decoded from one of the checkpoint's blobs. */
async function readStep(
  codec: TranscriptOccurrenceCodec,
  scope: unknown,
  blobs: TranscriptOccurrenceBlobStore,
  id: Uint8Array,
  what: string,
): Promise<DecodedTranscriptStep> {
  return codec.decodeStep(await requiredBlob(scope, blobs, id, what));
}

function stripHiddenThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text a reader is shown for a message: scope tags stripped from the user's, hidden thinking from the agent's. */
function visibleTextFor(role: "user" | "assistant", text: string): string {
  const visible = role === "user" ? stripContextTags(text) : stripHiddenThinkingTags(text);
  return visible.trim() ? visible : "";
}

/** One message line in the shape the transcript projection carries. */
function textOccurrenceLine(role: "user" | "assistant", visible: string): string {
  return JSON.stringify({ role, message: { content: [{ type: "text", text: visible }] } });
}

/** A text line for one message, or nothing when nothing visible is left. */
function formatTextOccurrence(role: "user" | "assistant", text: string): string | undefined {
  const visible = visibleTextFor(role, text);
  return visible.length === 0 ? undefined : textOccurrenceLine(role, visible);
}

/** Whether a tool call was handed the same input both times. */
function sameToolCall(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The id of the line that carries the user's message of a turn. */
function userOccurrenceId(turnNumber: number): string {
  return ["turn", turnNumber, "user"].join(":");
}

/** The id of one line derived from a turn's step. */
function stepOccurrenceId(turnNumber: number, stepNumber: number, kind: "text" | "tool-use" | "tool-result"): string {
  return ["turn", turnNumber, "step", stepNumber, kind].join(":");
}

/** The user's message text, which may live in a separate blob rather than in the message itself. */
async function userTextFor(
  codec: TranscriptOccurrenceCodec,
  scope: unknown,
  blobs: TranscriptOccurrenceBlobStore,
  userBlobId: Uint8Array,
): Promise<string> {
  const user = codec.decodeUserMessage(await requiredBlob(scope, blobs, userBlobId, "user-message"));
  if (user.text.length > 0 || user.textBlobId == null || user.textBlobId.length === 0) return user.text;
  return new TextDecoder().decode(await requiredBlob(scope, blobs, user.textBlobId, "user-message text"));
}

/** Refuse a turn whose kind changed between checkpoints. */
function assertTurnKindUnchanged(current: DecodedTranscriptTurn, previous: DecodedTranscriptTurn | undefined): void {
  if (previous != null && previous.case !== current.case) throw corruption("durable conversation turn changed kind");
}

/** Refuse a user message that was edited after the previous checkpoint. */
function assertUserMessageUnchanged(agentBefore: DecodedTranscriptTurn | undefined, current: DecodedTranscriptTurn): void {
  if (current.case !== "agent" || agentBefore?.case !== "agent") return;
  if (!bytesEqual(agentBefore.userMessage, current.userMessage)) {
    throw corruption("durable agent user message changed after checkpoint");
  }
}

/** Refuse a turn whose recorded steps were removed. */
function assertStepsDidNotMoveBackwards(agentBefore: DecodedTranscriptTurn | undefined, current: DecodedTranscriptTurn): void {
  if (current.case !== "agent" || agentBefore?.case !== "agent") return;
  if (current.steps.length < agentBefore.steps.length) throw corruption("durable agent steps moved backwards");
}

/**
 * Where the steps that need deriving start: after the steps the previous checkpoint already had, unless the last of
 * those steps changed (only allowed at the tail) or a deferred step was held back from an earlier attempt.
 */
function firstChangedStep(
  agentBefore: DecodedTranscriptTurn | undefined,
  current: DecodedTranscriptTurn,
  heldStep: DeferredTranscriptStep | undefined,
  turnNumber: number,
): number {
  let boundary = agentBefore?.case === "agent" ? agentBefore.steps.length : 0;
  if (current.case === "agent" && agentBefore?.case === "agent") {
    for (let index = 0; index < agentBefore.steps.length; index += 1) {
      if (bytesEqual(agentBefore.steps[index]!, current.steps[index]!)) continue;
      if (index + 1 !== agentBefore.steps.length) throw corruption("durable agent step changed before the checkpoint tail");
      boundary = index;
      break;
    }
  }
  if (heldStep?.turnIndex === turnNumber) boundary = Math.min(boundary, heldStep.stepIndex);
  return boundary;
}

/** The lines one turn's steps produce, and the step held back because the turn is still being written. */
async function deriveSteps(
  codec: TranscriptOccurrenceCodec,
  scope: unknown,
  blobs: TranscriptOccurrenceBlobStore,
  turnNumber: number,
  steps: readonly Uint8Array[],
  agentBefore: DecodedTranscriptTurn | undefined,
  boundary: number,
  finalizeTurn: boolean,
): Promise<{ producedLines: TranscriptOccurrence[]; heldStep?: DeferredTranscriptStep }> {
  const producedLines: TranscriptOccurrence[] = [];
  for (let stepNumber = boundary; stepNumber < steps.length; stepNumber += 1) {
    const stepBeforeBlob = agentBefore?.case === "agent" ? agentBefore.steps[stepNumber] : undefined;
    const stepBefore = stepBeforeBlob == null
      ? undefined
      : await readStep(codec, scope, blobs, stepBeforeBlob, "previous conversation-step");
    const step = await readStep(codec, scope, blobs, steps[stepNumber]!, "conversation-step");
    if (stepBefore != null && stepBefore.case !== step.case) throw corruption("durable conversation step changed kind");

    // The last words of a turn that is still being written are held back until the turn is finished.
    if (!finalizeTurn && stepNumber + 1 === steps.length && (step.case === "assistant" || step.case === "thinking")) {
      return { producedLines, heldStep: { turnIndex: turnNumber, stepIndex: stepNumber } };
    }
    if (step.case === "assistant" || step.case === "thinking") {
      const line = formatTextOccurrence("assistant", step.text);
      if (line != null) producedLines.push({ id: stepOccurrenceId(turnNumber, stepNumber, "text"), line });
      continue;
    }
    if (step.case !== "tool") continue;
    if (stepBefore != null && stepBefore.case !== "tool") throw corruption("durable conversation step changed into a tool call");
    if (stepBefore?.case === "tool") {
      if (stepBefore.name !== step.name || !sameToolCall(stepBefore.input, step.input)) {
        throw corruption("durable tool call changed after checkpoint");
      }
      if (stepBefore.result !== undefined) throw corruption("completed durable tool call changed after checkpoint");
      if (step.result !== undefined) {
        producedLines.push({ id: stepOccurrenceId(turnNumber, stepNumber, "tool-result"), line: formatToolLine("tool", step.name, step.result) });
      }
      continue;
    }
    producedLines.push({ id: stepOccurrenceId(turnNumber, stepNumber, "tool-use"), line: formatToolLine("assistant", step.name, step.input) });
    if (step.result !== undefined) {
      producedLines.push({ id: stepOccurrenceId(turnNumber, stepNumber, "tool-result"), line: formatToolLine("tool", step.name, step.result) });
    }
  }
  return { producedLines };
}

/** Refuse a checkpoint whose area before the active turn no longer matches the previous one. */
function assertHistoryUnchanged(previous: TranscriptCheckpoint, checkpoint: TranscriptCheckpoint): void {
  if (checkpoint.turns.length < previous.turns.length) throw corruption("durable conversation turns moved backwards");
  if (
    previous.turns.length > 1
    && !bytesEqual(checkpoint.turns[previous.turns.length - 2]!, previous.turns[previous.turns.length - 2]!)
  ) {
    throw corruption("durable conversation history changed before the active turn");
  }
}

/** The first step held back for the next checkpoint, if any turn held one back. */
function firstDeferredStep(derived: ReadonlyArray<{ readonly heldStep?: DeferredTranscriptStep }>): DeferredTranscriptStep | undefined {
  return derived.find(turn => turn.heldStep != null)?.heldStep;
}

/** The deriver the transcript mirror calls: it reads blobs through the codec it was built with. */
export class ArtifactTranscriptOccurrenceDeriver
implements TranscriptDeriver<TranscriptOccurrenceBlobStore> {
  constructor(readonly codec: TranscriptOccurrenceCodec) {}

  private async deriveTurn(
    scope: unknown,
    blobs: TranscriptOccurrenceBlobStore,
    turnNumber: number,
    blobNowId: Uint8Array,
    blobBeforeId: Uint8Array | undefined,
    finalizeTurn = false,
    heldStep?: DeferredTranscriptStep,
  ): Promise<{ readonly producedLines: readonly TranscriptOccurrence[]; readonly heldStep?: DeferredTranscriptStep }> {
    const current = await readTurn(this.codec, scope, blobs, blobNowId, "conversation-turn");
    if (current.case === "shell") throw corruption("Slate does not support shell conversation turns");
    const previous = blobBeforeId == null
      ? undefined
      : await readTurn(this.codec, scope, blobs, blobBeforeId, "previous conversation-turn");
    assertTurnKindUnchanged(current, previous);
    if (current.case !== "agent") return { producedLines: [] };
    const agentBefore = previous?.case === "agent" ? previous : undefined;
    assertUserMessageUnchanged(agentBefore, current);
    assertStepsDidNotMoveBackwards(agentBefore, current);

    const producedLines: TranscriptOccurrence[] = [];
    if (agentBefore == null) {
      const wordsLine = formatTextOccurrence("user", await userTextFor(this.codec, scope, blobs, current.userMessage));
      if (wordsLine != null) producedLines.push({ id: userOccurrenceId(turnNumber), line: wordsLine });
    }
    const stepLines = await deriveSteps(
      this.codec,
      scope,
      blobs,
      turnNumber,
      current.steps,
      agentBefore,
      firstChangedStep(agentBefore, current, heldStep, turnNumber),
      finalizeTurn,
    );
    producedLines.push(...stepLines.producedLines);
    return stepLines.heldStep == null
      ? { producedLines }
      : { producedLines, heldStep: stepLines.heldStep };
  }

  async initial(
    scope: unknown,
    blobs: TranscriptOccurrenceBlobStore,
    checkpoint: TranscriptCheckpoint,
  ): Promise<readonly TranscriptOccurrence[]> {
    const producedLines: TranscriptOccurrence[] = [];
    for (const [turnNumber, turnId] of checkpoint.turns.entries()) {
      const turn = await this.deriveTurn(scope, blobs, turnNumber, turnId, undefined, true);
      producedLines.push(...turn.producedLines);
    }
    return producedLines;
  }

  async derive(
    scope: unknown,
    blobs: TranscriptOccurrenceBlobStore,
    previous: TranscriptCheckpoint,
    checkpoint: TranscriptCheckpoint,
    finalizeCheckpoint: boolean,
    deferred?: DeferredTranscriptStep,
  ): Promise<{ readonly occurrences: readonly TranscriptOccurrence[]; readonly deferredStep?: DeferredTranscriptStep }> {
    assertHistoryUnchanged(previous, checkpoint);
    const derived: Array<{
      readonly turnNumber: number;
      readonly producedLines: readonly TranscriptOccurrence[];
      readonly heldStep?: DeferredTranscriptStep;
    }> = [];
    if (previous.turns.length > 0) {
      const turnNumber = previous.turns.length - 1;
      const changed = !bytesEqual(previous.turns[turnNumber]!, checkpoint.turns[turnNumber]!)
        || deferred?.turnIndex === turnNumber;
      if (changed) {
        derived.push({
          turnNumber,
          ...await this.deriveTurn(
            scope,
            blobs,
            turnNumber,
            checkpoint.turns[turnNumber]!,
            previous.turns[turnNumber]!,
            finalizeCheckpoint || turnNumber + 1 < checkpoint.turns.length,
            deferred,
          ),
        });
      }
    }
    for (let turnNumber = previous.turns.length; turnNumber < checkpoint.turns.length; turnNumber += 1) {
      derived.push({
        turnNumber,
        ...await this.deriveTurn(
          scope,
          blobs,
          turnNumber,
          checkpoint.turns[turnNumber]!,
          undefined,
          finalizeCheckpoint || turnNumber + 1 < checkpoint.turns.length,
          deferred,
        ),
      });
    }
    const heldBack = firstDeferredStep(derived);
    return {
      occurrences: derived.flatMap(turn => turn.producedLines),
      ...(heldBack == null ? {} : { deferredStep: heldBack }),
    };
  }
}

/** Whether an object carries every decoding method the deriver needs. */
function isCompleteCodec(codec: TranscriptOccurrenceCodec | undefined): boolean {
  return typeof codec?.decodeTurn === "function"
    && typeof codec.decodeUserMessage === "function"
    && typeof codec.decodeStep === "function";
}

/** Build the deriver, refusing a codec that could not decode a transcript at all. */
export function createTranscriptOccurrenceDeriver(codec: TranscriptOccurrenceCodec): ArtifactTranscriptOccurrenceDeriver {
  if (!isCompleteCodec(codec)) throw new TypeError("generated transcript occurrence codec is incomplete");
  return new ArtifactTranscriptOccurrenceDeriver(codec);
}

/**
 * Watching a shell terminal.
 *
 * Output that arrives before anyone is looking is held — bounded, and by how long it is worth keeping — so a reader that
 * attaches late still sees what happened, and a terminal that ends is reported as ended.
 */
import { Buffer } from "node:buffer";
import { isGroupTurnPromptText } from "../groups/group-chat.ts";
import {
  parseShellTerminalFooter,
  SHELL_REWATCH_MAX_WAIT_MS,
  SHELL_REWATCH_MISSING_FILE_GIVE_UP,
  shellRewatchPollMs,
} from "./background-work.ts";
import { selectUnconfirmedUserMessages } from "./conversation-state.ts";
import { SLATE_HIDDEN_PROMPT_MARKER } from "./slate-prompt-markers.ts";
import { buildUserMessageAddressNote } from "./system-prompt.ts";
import {
  SlateLocalToolPermissionDeniedError,
  slateLocalToolScopeKey,
} from "../../shared/local-tool-permission-machinery.ts";
import type { Context } from "../../packages/context/context.ts";

export class SlateTerminalReadError extends Error {
}

export type TerminalReadResult =
  | { readonly kind: "success"; readonly text?: string; readonly bytes?: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "failure"; readonly resultName: string };

export interface TerminalRemoteAccessor<Context> {
  read(turnContext: Context, args: { readonly path: string; readonly toolCallId: string }): Promise<TerminalReadResult>;
}

export type ShellWatchConversationTurn =
  | { readonly kind: "agent"; readonly userMessageBlobId?: Uint8Array }
  | { readonly kind: "other" };

export interface TerminalConnection<Context> {
  readonly terminalsFolder: string;
  readonly remoteAccessor: TerminalRemoteAccessor<Context>;
}

export interface RecentTerminalUserMessage {
  readonly id: string;
  readonly text: string;
  readonly richText?: string;
}

export interface MaterializedUserMessage {
  readonly text: string;
  readonly messageId: string;
  readonly richText?: string;
}

export interface ConfirmedUserTurnWatermark {
  readonly turnCount: number;
  readonly boundaryRef: Uint8Array;
  readonly lastUserMessageId?: string;
  readonly hasUserTurn: boolean;
}

export interface ShellTerminalWatchHost<Context> {
  readonly ctx: Context;
  getConversationId(): string;
  ensureBoxReady(turnContext: Context, conversationId: string): Promise<TerminalConnection<Context>>;
  createLocalToolContext?(turnContext: Context, agentId: string): Context;
  terminalFilePath?(terminalsFolder: string, id: string): string | undefined;
  getConversationState(): { readonly turns: readonly Uint8Array[] };
  getBlob(turnContext: Context, blobRef: Uint8Array): Promise<Uint8Array | null>;
  decodeConversationTurn(rawBytes: Uint8Array): ShellWatchConversationTurn;
  decodeUserMessage(rawBytes: Uint8Array): MaterializedUserMessage;
  getConfirmedUserTurnWatermarkCache(): ConfirmedUserTurnWatermark | undefined;
  setConfirmedUserTurnWatermarkCache(cache: ConfirmedUserTurnWatermark): void;
  now?(): number;
  delay?(milliseconds: number): Promise<void>;
}

export interface TerminalFileSnapshot {
  readonly exists: boolean;
  readonly content: string;
}

export type ShellWatchStatus = "success" | "error";

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function readShellTerminalSnapshot<Context>(
  _host: ShellTerminalWatchHost<Context>,
  reads: TerminalRemoteAccessor<Context>,
  path: string,
  turnContext: Context,
): Promise<TerminalFileSnapshot> {
  const result = await reads.read(turnContext, { path, toolCallId: "" });
  if (result.kind === "missing") return { exists: false, content: "" };
  if (result.kind === "failure") {
    throw new SlateTerminalReadError(`terminal file read failed (${result.resultName})`);
  }
  const content = result.text ?? (result.bytes === undefined ? "" : Buffer.from(result.bytes).toString("utf8"));
  return { exists: true, content };
}

export async function pollShellTerminalFile<Context>(
  shellHost: ShellTerminalWatchHost<Context>,
  id: string,
  cancelled: () => boolean,
  settle: (watchStatus: ShellWatchStatus, watchDetail?: string, watchPath?: string) => void,
): Promise<void> {
  const pollInterval = shellRewatchPollMs();
  const now = shellHost.now ?? Date.now;
  const delay = shellHost.delay ?? defaultDelay;
  const deadline = now() + SHELL_REWATCH_MAX_WAIT_MS;
  let missingCount = 0;
  let watchPath: string | undefined;
  while (!cancelled()) {
    try {
      const scoped = shellHost.ctx as unknown as {
        with?: (
          key: typeof slateLocalToolScopeKey,
          value: { readonly agentId: string },
        ) => Context;
      };
      const scopedContext = typeof scoped.with === "function"
        ? scoped.with(
          slateLocalToolScopeKey,
          { agentId: shellHost.getConversationId() },
        )
        : shellHost.createLocalToolContext?.(
          shellHost.ctx,
          shellHost.getConversationId(),
        ) ?? shellHost.ctx;
      const terminal = await shellHost.ensureBoxReady(scopedContext, shellHost.getConversationId());
      const terminalsFolder = terminal.terminalsFolder;
      watchPath = shellHost.terminalFilePath?.(terminalsFolder, id) ?? `${terminalsFolder}/${id}.txt`;
      const fileSnapshot = await readShellTerminalSnapshot(
        shellHost,
        terminal.remoteAccessor,
        watchPath,
        scopedContext,
      );
      if (fileSnapshot.exists) {
        missingCount = 0;
        const completion = parseShellTerminalFooter(fileSnapshot.content);
        if (completion.isComplete) {
          const watchStatus = completion.exitCode === 0 ? "success" : "error";
          const watchDetail = completion.exitCode === 0
            ? undefined
            : completion.isStreamFailure === true
              ? "the command's output stream failed; read its output file for the error"
              : `exit_code=${completion.exitCode ?? "unknown"}`;
          settle(watchStatus, watchDetail, watchPath);
          return;
        }
      } else {
        missingCount += 1;
        if (missingCount >= SHELL_REWATCH_MISSING_FILE_GIVE_UP) {
          settle(
            "error",
            "The command's terminal output file no longer exists, so its completion can no longer be observed (it may have been cleaned up).",
            watchPath,
          );
          return;
        }
      }
    } catch (error) {
      if (error instanceof SlateLocalToolPermissionDeniedError) {
        settle(
          "error",
          "Slate is no longer allowed to read this command's output on the user's computer, so its completion cannot be observed. The command keeps running; ask the user to approve reading its output file for the result.",
          watchPath,
        );
        return;
      }
    }
    if (now() >= deadline) break;
    await delay(pollInterval);
  }
  if (cancelled()) return;
  settle(
    "error",
    `The command is still running after ${Math.round(SHELL_REWATCH_MAX_WAIT_MS / 60_000)} minutes. It keeps running; check its output file for the result.`,
    watchPath,
  );
}

export async function collectPrependUserMessageRecords<Context>(
  shellHost: ShellTerminalWatchHost<Context>,
  recentMessages: readonly RecentTerminalUserMessage[] | null | undefined,
  currentMessageId?: string,
): Promise<MaterializedUserMessage[]> {
  if (recentMessages == null || recentMessages.length === 0) return [];
  const conversationState = shellHost.getConversationState();
  const { lastUserMessageId, hasUserTurn } = await findConfirmedUserTurnWatermark(shellHost, conversationState);
  const unconfirmed = selectUnconfirmedUserMessages({
    recentUserMessages: recentMessages,
    ...(currentMessageId == null ? {} : { currentMessageId }),
    ...(lastUserMessageId == null ? {} : { lastTurnUserMessageId: lastUserMessageId }),
    hasConfirmedTurns: hasUserTurn,
  });
  return unconfirmed.map((recentMessage) => {
    const addressText = buildUserMessageAddressNote(recentMessage.id);
    const text = addressText.length > 0 ? `${addressText}\n${recentMessage.text}` : recentMessage.text;
    return {
      text,
      messageId: recentMessage.id,
      ...(recentMessage.richText != null && recentMessage.richText.length > 0
        ? { richText: recentMessage.richText }
        : {}),
    };
  });
}

export async function findConfirmedUserTurnWatermark<Context>(
  shellHost: ShellTerminalWatchHost<Context>,
  conversationState: { readonly turns: readonly Uint8Array[] },
): Promise<{ readonly lastUserMessageId?: string; readonly hasUserTurn: boolean }> {
  const cached = shellHost.getConfirmedUserTurnWatermarkCache();
  const boundary = cached != null && cached.turnCount > 0 && cached.turnCount <= conversationState.turns.length
    ? conversationState.turns[cached.turnCount - 1]
    : undefined;
  const cacheUsable = cached != null && (
    cached.turnCount === 0
    || (boundary != null && turnRefsEqual(boundary, cached.boundaryRef))
  );
  const scanStop = cacheUsable ? cached.turnCount : 0;
  const cachedAnswer = (
    result: { readonly lastUserMessageId?: string; readonly hasUserTurn: boolean },
  ) => {
    const turnTotal = conversationState.turns.length;
    shellHost.setConfirmedUserTurnWatermarkCache({
      turnCount: turnTotal,
      boundaryRef: turnTotal > 0 ? conversationState.turns[turnTotal - 1] ?? new Uint8Array() : new Uint8Array(),
      ...(result.lastUserMessageId == null
        ? {}
        : { lastUserMessageId: result.lastUserMessageId }),
      hasUserTurn: result.hasUserTurn,
    });
    return result;
  };

  for (let index = conversationState.turns.length - 1; index >= scanStop; index -= 1) {
    const turnBlobRef = conversationState.turns[index];
    if (turnBlobRef == null || turnBlobRef.length === 0) continue;
    let userMessage: { readonly text: string; readonly messageId: string };
    try {
      const turnBlob = await shellHost.getBlob(shellHost.ctx, turnBlobRef);
      if (turnBlob == null) return { hasUserTurn: true };
      const turn = shellHost.decodeConversationTurn(turnBlob);
      if (turn.kind !== "agent") continue;
      const userBlobRef = turn.userMessageBlobId;
      if (userBlobRef == null || userBlobRef.length === 0) {
        return { hasUserTurn: true };
      }
      const userBlob = await shellHost.getBlob(shellHost.ctx, userBlobRef);
      if (userBlob == null) return { hasUserTurn: true };
      userMessage = shellHost.decodeUserMessage(userBlob);
    } catch {
      return { hasUserTurn: true };
    }
    if (userMessage.text.startsWith(SLATE_HIDDEN_PROMPT_MARKER)) continue;
    if (userMessage.messageId.length === 0 && isGroupTurnPromptText(userMessage.text)) continue;
    return cachedAnswer({
      lastUserMessageId: userMessage.messageId,
      hasUserTurn: true,
    });
  }
  if (cached != null && cacheUsable && scanStop > 0) {
    return cachedAnswer({
      ...(cached.lastUserMessageId == null
        ? {}
        : { lastUserMessageId: cached.lastUserMessageId }),
      hasUserTurn: cached.hasUserTurn,
    });
  }
  return cachedAnswer({ hasUserTurn: false });
}

export function turnRefsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

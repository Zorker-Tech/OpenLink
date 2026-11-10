/** What the cards in a session do when they are answered.

 * A card that asks a question, offers a widget, asks for a secret or proposes a permission is answered, dismissed,
 * reacted to or left to expire here: the answer is written onto the transcriptEntry so a timeline shows it, the agent is resumed
 * when the platform decides it should be, and a card that went stale is didRetire on the session it belongs to. */
import { errorLogTag } from "../../shared/errors/summary.ts";
import {
  mainTranscriptOf,
  threadOf,
  isPeerMessage,
  SLATE_REACTION_SELF,
  settledAutoReviewEntry,
  settledToolPermissionEntry,
} from "../../shared/transcript.ts";
import { buildSecretProvidedAck } from "../runner/tools/slate-secret-request.ts";
import { SPEND_GUARD_VALUE_PREFIX } from "./slate-automation-spend-guard.ts";
import {
  describeReactedMessageQuote,
  isUserMessageEntry,
  skippablePromptSummary,
  toggleReaction,
} from "./send-message-shaping.ts";
import { getTranscript, updateEntry } from "./transcript-store.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";

type LiveSession = any;

export class WidgetResponses {
  constructor(readonly tm: TranscriptManagerLike) {}

  collectUnansweredQuestionPrompts(session: LiveSession): {
    skippedQuestionPrompts: string[];
    dismissedQuestionPrompts: string[];
  } {
    const isActive = session.id === this.tm.sessions.activeSession?.id;
    const entryList = isActive
      ? getTranscript()
      : session.db.getTranscriptEntries();
    const skippedQuestionPrompts: string[] = [];
    const dismissedQuestionPrompts: string[] = [];
    for (const transcriptEntry of entryList) {
      if (
        transcriptEntry.kind !== "send-message" ||
        transcriptEntry.respondedValue != null ||
        transcriptEntry.widgetSkipped === true
      )
        continue;
      const promptSummary = skippablePromptSummary(transcriptEntry.message as any);
      if (promptSummary == null) continue;
      if (transcriptEntry.widgetDismissed === true)
        dismissedQuestionPrompts.push(promptSummary);
      else skippedQuestionPrompts.push(promptSummary);
      const markSkipped = (current: TranscriptEntry): TranscriptEntry =>
        current.kind === "send-message"
          ? { ...current, widgetSkipped: true }
          : current;
      if (isActive) {
        const stampedEntry = updateEntry(transcriptEntry.id, markSkipped);
        if (stampedEntry != null)
          this.tm.roster.emit({ type: "updated", entry: stampedEntry });
      }
      session.db.updateTranscriptEntry(transcriptEntry.id, markSkipped);
    }
    return { skippedQuestionPrompts, dismissedQuestionPrompts };
  }

  async respondToWidget(
    entryId: string,
    text: string,
    agentId: string,
  ): Promise<{ accepted: boolean }> {
    const cleanValue = text.trim();
    if (cleanValue.length === 0) return { accepted: false };
    await this.tm.sessions.ensureActionTarget(agentId);
    const targetAgentId = this.tm.sessions.activeSession?.id;
    if (!this.recordWidgetResponse(entryId, cleanValue))
      return { accepted: false };

    const widgetRow = getTranscript().find((transcriptEntry) => transcriptEntry.id === entryId);
    const replyToId =
      widgetRow?.kind === "send-message"
        ? (widgetRow.replyTo as string | undefined)
        : undefined;
    let wakePrompt = cleanValue;
    let guardedOk = false;
    try {
      if (
        cleanValue.startsWith(SPEND_GUARD_VALUE_PREFIX) &&
        targetAgentId != null
      ) {
        const applied =
          await this.tm.automationRuntime.handleSpendGuardWidgetAnswer({
            agentId: targetAgentId,
            entryId,
            value: cleanValue,
            onApplied: () => {
              guardedOk = true;
            },
          });
        if (applied == null) {
          this.rollbackWidgetResponse(entryId);
          return { accepted: false };
        }
        wakePrompt = applied;
      }
      await this.tm.sendPrompt(wakePrompt, {
        ...(targetAgentId == null ? {} : { agentId: targetAgentId }),
        ...(replyToId == null ? {} : { replyToId }),
        appendUserMessage: false,
        awaitTurn: false,
      });
    } catch (error) {
      if (guardedOk) return { accepted: true };
      this.rollbackWidgetResponse(entryId);
      throw error;
    }
    return { accepted: true };
  }

  async settleStaleAutoReviewCard(input: {
    agentId: string;
    entryId: string;
    requestId: string;
  }): Promise<boolean> {
    if (
      this.settlePendingAutoReviewApprovalsOnSession({
        agentId: input.agentId,
        status: "expired",
        requestId: input.requestId,
      })
    )
      return true;
    const staleList = await this.tm.sessionStore.expirePendingAutoReviewApprovals(
      input.agentId,
      input.requestId,
    );
    if (staleList.length > 0) void this.tm.roster.emitAgentUpdate(input.agentId);
    const settledEntry = this.tm.sessionStore
      .readAgentTranscriptEntries(input.agentId)
      .find(
        (transcriptEntry: any) =>
          transcriptEntry.id === input.entryId &&
          transcriptEntry.kind === "send-message" &&
          transcriptEntry.message.type === "auto-review-approval" &&
          transcriptEntry.message.approval.requestId === input.requestId,
      );
    if (settledEntry == null) return false;
    this.tm.roster.emit({ type: "updated", entry: settledEntry }, input.agentId);
    return true;
  }

  async expireAllPendingAutoReviewApprovalCards(): Promise<void> {
    const reportFailure = (stage: string, error: unknown): void => {
      this.tm.telemetry.reportAutoReviewExpireSweepFailed({
        stage,
        errorClass: errorLogTag(error),
      });
    };
    try {
      const activeAgentKey = this.tm.sessions.activeSession?.id;
      if (activeAgentKey != null) {
        this.settlePendingAutoReviewApprovalsOnSession({
          agentId: activeAgentKey,
          status: "expired",
        });
      }
      let agentIdList: string[];
      try {
        agentIdList = await this.tm.sessionStore.listAgentIds();
      } catch (error) {
        reportFailure("list_agents", error);
        return;
      }
      for (const agentId of agentIdList) {
        if (agentId === activeAgentKey) continue;
        try {
          const staleList =
            await this.tm.sessionStore.expirePendingAutoReviewApprovals(
              agentId,
            );
          if (staleList.length > 0) void this.tm.roster.emitAgentUpdate(agentId);
        } catch (error) {
          reportFailure("expire_agent", error);
        }
      }
    } catch (error) {
      reportFailure("sweep", error);
    }
  }

  settlePendingAutoReviewApprovalsOnSession(input: {
    agentId: string;
    status: string;
    requestId?: string;
  }): boolean {
    const session = this.liveSessionFor(input.agentId);
    if (session == null) return false;
    let didRetire = false;
    for (const transcriptEntry of session.db.getTranscriptEntries()) {
      const settledEntry = settledAutoReviewEntry(
        transcriptEntry,
        input.status,
        input.requestId,
      ) as TranscriptEntry | null;
      if (settledEntry == null) continue;
      session.db.updateTranscriptEntry(transcriptEntry.id, () => settledEntry);
      didRetire = true;
      const liveEntry =
        input.agentId === this.tm.sessions.activeSession?.id
          ? updateEntry(transcriptEntry.id, () => settledEntry)
          : null;
      this.tm.roster.emit(
        { type: "updated", entry: liveEntry ?? settledEntry },
        input.agentId,
      );
    }
    return didRetire;
  }

  async settleStaleLocalToolPermissionCard(input: {
    agentId: string;
    entryId: string;
    requestId: string;
  }): Promise<"retired" | "already-settled" | false> {
    if (this.settlePendingLocalToolPermissionAsksOnSession(input))
      return "retired";
    const staleList =
      await this.tm.sessionStore.expirePendingLocalToolPermissionAsks({
        agentId: input.agentId,
        onlyRequestId: input.requestId,
      });
    if (staleList.length > 0) void this.tm.roster.emitAgentUpdate(input.agentId);
    const settledEntry = this.tm.sessionStore
      .readAgentTranscriptEntries(input.agentId)
      .find(
        (transcriptEntry: any) =>
          transcriptEntry.id === input.entryId &&
          transcriptEntry.kind === "send-message" &&
          transcriptEntry.message.type === "local-tool-permission" &&
          transcriptEntry.message.ask.requestId === input.requestId,
      );
    if (settledEntry == null) return false;
    this.tm.roster.emit({ type: "updated", entry: settledEntry }, input.agentId);
    return staleList.length > 0 ? "retired" : "already-settled";
  }

  async expireAllPendingLocalToolPermissionCards(sweepOptions?: {
    ifPendingBeforeMs?: number;
  }): Promise<void> {
    try {
      const activeAgentKey = this.tm.sessions.activeSession?.id;
      if (activeAgentKey != null) {
        this.settlePendingLocalToolPermissionAsksOnSession({
          agentId: activeAgentKey,
          ...(sweepOptions?.ifPendingBeforeMs == null
            ? {}
            : { ifPendingBeforeMs: sweepOptions.ifPendingBeforeMs }),
        });
      }
      let agentIdList: string[];
      try {
        agentIdList = await this.tm.sessionStore.listAgentIds();
      } catch {
        return;
      }
      for (const agentId of agentIdList) {
        if (agentId === activeAgentKey) continue;
        try {
          const staleList =
            await this.tm.sessionStore.expirePendingLocalToolPermissionAsks({
              agentId,
              ifPendingBeforeMs: sweepOptions?.ifPendingBeforeMs,
            });
          if (staleList.length > 0) void this.tm.roster.emitAgentUpdate(agentId);
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  settlePendingLocalToolPermissionAsksOnSession(input: {
    agentId: string;
    requestId?: string;
    ifPendingBeforeMs?: number;
  }): boolean {
    const session = this.liveSessionFor(input.agentId);
    if (session == null) return false;
    let didRetire = false;
    for (const transcriptEntry of session.db.getTranscriptEntries()) {
      if (
        input.ifPendingBeforeMs != null &&
        transcriptEntry.kind === "send-message" &&
        transcriptEntry.timestampMs != null &&
        transcriptEntry.timestampMs >= input.ifPendingBeforeMs
      )
        continue;
      const settledEntry = settledToolPermissionEntry(
        transcriptEntry,
        "expired",
        input.requestId,
      ) as TranscriptEntry | null;
      if (settledEntry == null) continue;
      session.db.updateTranscriptEntry(transcriptEntry.id, () => settledEntry);
      didRetire = true;
      const liveEntry =
        input.agentId === this.tm.sessions.activeSession?.id
          ? updateEntry(transcriptEntry.id, () => settledEntry)
          : null;
      this.tm.roster.emit(
        { type: "updated", entry: liveEntry ?? settledEntry },
        input.agentId,
      );
    }
    return didRetire;
  }

  async dismissWidget(input: {
    entryId: string;
    agentId: string;
  }): Promise<{ accepted: boolean }> {
    await this.tm.sessions.ensureActionTarget(input.agentId);
    const currentEntry = getTranscript().find((transcriptEntry) => transcriptEntry.id === input.entryId);
    if (
      currentEntry == null ||
      currentEntry.kind !== "send-message" ||
      (currentEntry.message as any)?.type !== "widget" ||
      currentEntry.respondedValue != null ||
      currentEntry.widgetDismissed === true
    )
      return { accepted: false };
    let didStamp = false;
    const markDismissed = (transcriptEntry: TranscriptEntry): TranscriptEntry => {
      if (
        transcriptEntry.kind !== "send-message" ||
        transcriptEntry.respondedValue != null ||
        transcriptEntry.widgetDismissed === true
      )
        return transcriptEntry;
      didStamp = true;
      const { widgetSkipped: _skipped, ...remainder } = transcriptEntry;
      return { ...remainder, widgetDismissed: true } as TranscriptEntry;
    };
    const stampedEntry = updateEntry(input.entryId, markDismissed);
    if (didStamp && stampedEntry != null) {
      this.tm.roster.emit({ type: "updated", entry: stampedEntry });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        input.entryId,
        markDismissed,
      );
    }
    return { accepted: didStamp };
  }

  async submitSecret(
    entryId: string,
    text: string,
    agentId: string,
  ): Promise<void> {
    const cleanText = text.trim();
    if (cleanText.length === 0) return;
    await this.tm.sessions.ensureActionTarget(agentId);
    const session = this.tm.sessions.activeSession;
    if (session == null) return;
    const transcriptEntry = getTranscript().find((item) => item.id === entryId);
    if (
      transcriptEntry == null ||
      transcriptEntry.kind !== "send-message" ||
      (transcriptEntry.message as any)?.type !== "secret-request" ||
      transcriptEntry.secretProvided === true
    )
      return;
    const secretTarget = (transcriptEntry.message as any).secretRequest;
    if (!this.routeSecret(session.id, secretTarget.target, cleanText)) {
      this.tm.trayErrors.pushError({
        agentId: session.id,
        title: "Could not store the secret",
        detail: "The secure input could not write the credential to its store.",
      });
      return;
    }
    const markProvided = (item: TranscriptEntry): TranscriptEntry =>
      item.kind === "send-message" ? { ...item, secretProvided: true } : item;
    const stampedEntry = updateEntry(entryId, markProvided);
    if (stampedEntry != null)
      this.tm.roster.emit({ type: "updated", entry: stampedEntry });
    session.db.updateTranscriptEntry(entryId, markProvided);
    await this.tm.boxHandoff.resumeWithHiddenPrompt(
      session.id,
      buildSecretProvidedAck(secretTarget),
      "Agent failed to resume after secret submission",
    );
  }

  routeSecret(agentId: string, credentialTarget: any, text: string): boolean {
    if (credentialTarget.kind !== "channel-credential") return false;
    const didStore = this.tm.sessionStore.storeConnectorCredential(
      agentId,
      credentialTarget.platform,
      credentialTarget.field,
      text,
    );
    if (didStore) this.tm.channelConfigChanged?.();
    return didStore;
  }

  recordWidgetResponse(entryId: string, text: string): boolean {
    const transcriptList = getTranscript();
    const currentEntry = transcriptList.find((transcriptEntry) => transcriptEntry.id === entryId);
    if (
      currentEntry == null ||
      currentEntry.kind !== "send-message" ||
      (currentEntry.message as any)?.type !== "widget" ||
      currentEntry.respondedValue != null ||
      currentEntry.widgetDismissed === true
    )
      return false;

    if ((currentEntry.message as any).widget.dismissOnMoveOn === true) {
      const hasLaterUserMoment = (
        page: readonly TranscriptEntry[],
      ): boolean => {
        const position = page.findIndex((transcriptEntry) => transcriptEntry.id === entryId);
        return (
          position >= 0 &&
          page
            .slice(position + 1)
            .some(
              (transcriptEntry) =>
                (isUserMessageEntry(transcriptEntry) &&
                  !isPeerMessage(transcriptEntry)) ||
                (transcriptEntry.kind === "send-message" &&
                  (transcriptEntry.message as any)?.type === "widget" &&
                  (transcriptEntry.respondedValue != null ||
                    transcriptEntry.widgetDismissed === true)),
            )
        );
      };
      const views: Array<readonly TranscriptEntry[]> = [];
      const mainView = mainTranscriptOf(
        transcriptList,
      ) as readonly TranscriptEntry[];
      if (mainView.some((transcriptEntry) => transcriptEntry.id === entryId)) views.push(mainView);
      const threadView = threadOf(
        transcriptList,
        entryId,
      ) as readonly TranscriptEntry[];
      if (threadView.length > 1) views.push(threadView);
      if (views.length > 0 && views.every(hasLaterUserMoment))
        return false;
    }

    let didStamp = false;
    const withResponse = (transcriptEntry: TranscriptEntry): TranscriptEntry => {
      if (
        transcriptEntry.kind !== "send-message" ||
        transcriptEntry.respondedValue != null ||
        transcriptEntry.widgetDismissed === true
      )
        return transcriptEntry;
      didStamp = true;
      return { ...transcriptEntry, respondedValue: text };
    };
    const stampedEntry = updateEntry(entryId, withResponse);
    if (didStamp && stampedEntry != null) {
      this.tm.roster.emit({ type: "updated", entry: stampedEntry });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        entryId,
        withResponse,
      );
    }
    return didStamp;
  }

  rollbackWidgetResponse(entryId: string): TranscriptEntry | null {
    const withoutResponse = (transcriptEntry: TranscriptEntry): TranscriptEntry => {
      if (transcriptEntry.kind !== "send-message") return transcriptEntry;
      const { respondedValue: _value, ...remainder } = transcriptEntry;
      return remainder as TranscriptEntry;
    };
    const stampedEntry = updateEntry(entryId, withoutResponse);
    if (stampedEntry != null)
      this.tm.roster.emit({ type: "updated", entry: stampedEntry });
    this.tm.sessions.activeSession?.db.updateTranscriptEntry(
      entryId,
      withoutResponse,
    );
    return stampedEntry;
  }

  async reactToMessage(
    entryId: string,
    emoji: string,
    agentId: string,
  ): Promise<void> {
    const cleanText = emoji.trim();
    if (cleanText.length === 0) return;
    await this.tm.sessions.ensureActionTarget(agentId);
    const reactResult = this.applyReaction({
      session: this.tm.sessions.activeSession ?? null,
      entryId,
      emoji: cleanText,
      by: SLATE_REACTION_SELF,
    });
    const activeAgentId = this.tm.sessions.activeSession?.id;
    if (
      reactResult?.isAdding &&
      activeAgentId != null &&
      !isUserMessageEntry(reactResult.before)
    ) {
      void this.resumeAfterReaction(
        activeAgentId,
        cleanText,
        describeReactedMessageQuote(reactResult.before),
      );
    }
  }

  applyReaction(input: {
    session?: LiveSession | null;
    entryId: string;
    emoji: string;
    by: string;
  }): { before: TranscriptEntry; isAdding: boolean } | null {
    const isActive =
      input.session == null ||
      input.session.id === this.tm.sessions.activeSession?.id;
    const entryList = isActive
      ? getTranscript()
      : input.session.db.getTranscriptEntries();
    const before = entryList.find(
      (transcriptEntry: TranscriptEntry) => transcriptEntry.id === input.entryId,
    );
    if (before == null) return null;
    const isAdding = !((before.reactions as any[]) ?? []).some(
      (reactionRow) => reactionRow.emoji === input.emoji && reactionRow.by === input.by,
    );
    const withToggle = (transcriptEntry: TranscriptEntry): TranscriptEntry => {
      const toggled = toggleReaction(transcriptEntry.reactions as any, input.emoji, input.by);
      const { reactions: _omit, ...remainder } = transcriptEntry;
      return toggled == null
        ? (remainder as TranscriptEntry)
        : { ...remainder, reactions: toggled };
    };
    if (isActive) {
      const stampedEntry = updateEntry(input.entryId, withToggle);
      if (stampedEntry == null) return null;
      this.tm.roster.emit({ type: "updated", entry: stampedEntry });
      this.tm.sessions.activeSession?.db.updateTranscriptEntry(
        input.entryId,
        withToggle,
      );
    } else {
      input.session.db.updateTranscriptEntry(input.entryId, withToggle);
      void this.tm.roster.emitAgentUpdate(input.session.id);
    }
    return { before, isAdding };
  }

  async resumeAfterReaction(
    agentId: string,
    emoji: string,
    messageQuote: string,
  ): Promise<void> {
    await this.tm.boxHandoff.resumeWithHiddenPrompt(
      agentId,
      `[The user reacted ${emoji} to your message: "${messageQuote}". You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).]`,
      "Agent failed to resume after reaction",
    );
  }

  private liveSessionFor(agentId: string): LiveSession | null {
    return this.tm.sessions.activeSession?.id === agentId
      ? this.tm.sessions.activeSession
      : (this.tm.sessions.liveSessions.get(agentId) ?? null);
  }
}

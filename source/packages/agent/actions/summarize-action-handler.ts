/**
 * The summarize action: the user asks for the conversation to be summarized now.
 *
 * Compaction normally happens on its own, when a conversation is large or long. This is the same work asked
 * for deliberately, and it differs in three ways. It waits for the summary rather than starting it in the
 * background, because the user asked for it and a half-done compaction would be a strange answer. It
 * summarizes the whole conversation rather than everything but a tail, since there is no turn in flight to
 * protect. And it leaves the conversation in a state that reflects the summary: the turns are cleared when
 * the session is configured that way, the token details are recomputed from what is left, and a checkpoint
 * is written — in the background when the session prefers that, because the user is waiting and a
 * checkpoint is bookkeeping rather than part of the answer.
 *
 * The one case that has to be repaired first is a prompt with no system message: a summarization is a model
 * call, so it needs the instructions the conversation would have been sent with, and they are built here
 * from the same generators the turn uses.
 */

import { BackgroundSummarizationMode } from "../../agent-summarization/background-summarization.ts";
import { createLogger, type Context } from "../../context/index.ts";
import { extractAutomationTriggerContext } from "./common.ts";
import { buildRequestContextOptions } from "./meta-agent-notes.ts";
import { getRequestContext } from "../utils/request-context.ts";
import { addSummarySystemInstructions } from "./summarize-action-system-prompt.ts";
import { applySummaryToConversation } from "./summarize-action-state.ts";
import type {
  RootPromptExecutor,
  SummarizeConfig,
  SummarizeLooseValue,
  SummarizeStateHandler,
} from "./summarize-action-contracts.ts";

const logger = createLogger("@slate/agent:summarize");

export class SummarizeActionHandler {
  readonly config: SummarizeConfig;
  readonly resourceAccessor: SummarizeLooseValue;
  readonly interactionListener: SummarizeLooseValue;
  readonly orchestrator: SummarizeLooseValue;
  readonly conversationActionReceiver: SummarizeLooseValue;

  constructor(
    config: SummarizeConfig,
    resourceAccessor: SummarizeLooseValue,
    interactionListener: SummarizeLooseValue,
    orchestrator: SummarizeLooseValue,
    conversationActionReceiver: SummarizeLooseValue,
  ) {
    this.config = config;
    this.resourceAccessor = resourceAccessor;
    this.interactionListener = interactionListener;
    this.orchestrator = orchestrator;
    this.conversationActionReceiver = conversationActionReceiver;
  }

  async handle(
    ctx: Context,
    _action: SummarizeLooseValue,
    rootPromptExecutor: RootPromptExecutor,
    stateHandler: SummarizeStateHandler,
    _mcpTools: SummarizeLooseValue,
    onStateUpdate?: ((ctx: Context, checkpoint: SummarizeLooseValue) => Promise<void>) | undefined,
  ): Promise<SummarizeLooseValue> {
    const hasAnyMessages = rootPromptExecutor.getMessages().length > 0;
    if (!hasAnyMessages) return await stateHandler.computeNewStructure(ctx);
    await addSummarySystemInstructions({
      context: ctx,
      prompt: rootPromptExecutor,
      state: stateHandler,
      config: this.config,
      resourceAccessor: this.resourceAccessor,
    });

    const requestContext = await getRequestContext(
      ctx,
      undefined,
      this.resourceAccessor,
      buildRequestContextOptions(this.config as SummarizeLooseValue),
    );
    const automationTriggerContext = this.config.automationInstructions !== undefined
      ? extractAutomationTriggerContext(rootPromptExecutor.getMessages())
      : undefined;
    const summary = await this.orchestrator.handleSummarization(
      ctx,
      stateHandler,
      rootPromptExecutor,
      this.interactionListener,
      this.config,
      requestContext,
      {
        fullSummarization: true,
        backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
        triggerReason: "force_option",
        resourceAccessor: this.resourceAccessor,
        automationTriggerContext,
      },
    );
    if (!summary) throw new Error("No summary generated, even though background summarization mode is WaitForCompletion");

    await applySummaryToConversation({
      context: ctx,
      summary,
      state: stateHandler,
      prompt: rootPromptExecutor,
      listener: this.interactionListener,
      clearTurns: this.config.summarizeActionClearTurns === true,
      privacyMode: stateHandler.getPrivacyMode(),
    });
    if (onStateUpdate) {
      if (this.config.fireAndForgetCheckpoints) {
        void stateHandler.computeNewStructure(ctx).then(async checkpoint => {
          await onStateUpdate(ctx, checkpoint);
        }).catch(error => {
          logger.error(ctx, "Failed to persist summarization checkpoint", { error });
        });
      } else {
        const checkpoint = await stateHandler.computeNewStructure(ctx);
        await onStateUpdate(ctx, checkpoint);
      }
    }
    return await stateHandler.computeNewStructure(ctx);
  }
}

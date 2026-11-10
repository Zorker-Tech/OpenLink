/**
 * The channel an agent talks to its client through, and the fallback when there is no client.
 *
 * Everything an agent needs a decision on travels over this one interface: updates it sends out, and
 * questions it asks back. An environment without a client (a CLI, a test, a headless run) still has to
 * answer those questions, so the no-op listener answers each of them with the refusal or approval that
 * means "carry on without me" — and it is explicit about which ones it cannot support, because an agent
 * that believes a search was approved when it was not is worse than one that is told no.
 */

import { Responses } from "./interaction-queries.ts"
import type { SlateInteractionQuery, SlateInteractionResponse } from "./interaction-queries.ts"

export interface InteractionListenerContext {
  readonly canceled?: boolean
}

export interface InteractionListener<Context = InteractionListenerContext> {
  sendUpdate(context: Context, update: unknown): Promise<void>
  query(context: Context, query: SlateInteractionQuery): Promise<SlateInteractionResponse | undefined>
  enqueuePostTurnEndedWork?(work: () => Promise<unknown>): void
  flushPostTurnEndedWork?(context: Context): Promise<void>
}

export class InteractionListenerStreamClosedError extends Error {
  override readonly name = "InteractionListenerStreamClosedError"
  override readonly cause: unknown

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message)
    this.cause = options.cause
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export async function flushPostTurnEndedWork<Context>(
  context: Context,
  listener: Pick<InteractionListener<Context>, "flushPostTurnEndedWork">,
): Promise<void> {
  await listener.flushPostTurnEndedWork?.(context)
}

export class NoopInteractionListener<Context = InteractionListenerContext>
  implements InteractionListener<Context> {
  private postTurnEndedWorkQueue: Array<() => Promise<unknown>> = []

  async sendUpdate(_context: Context, _update: unknown): Promise<void> {}

  enqueuePostTurnEndedWork(work: () => Promise<unknown>): void {
    this.postTurnEndedWorkQueue.push(work)
  }

  /** Cleanup after a turn is best effort: one failed task must not stop the others. */
  async flushPostTurnEndedWork(_context: Context): Promise<void> {
    const work = this.postTurnEndedWorkQueue
    this.postTurnEndedWorkQueue = []
    await Promise.all(work.map(async task => {
      try {
        await task()
      } catch {
        // Deliberately swallowed.
      }
    }))
  }

  async query(_context: Context, query: SlateInteractionQuery): Promise<SlateInteractionResponse> {
    switch (query.kind) {
      case "web-search":
        return Responses.webSearchApproved(query.id)
      case "web-fetch":
        return Responses.webFetchApproved(query.id)
      case "ask-question":
        return Responses.askQuestion(query.id, {
          decision: "rejected",
          reason: "Questions skipped by user (CLI fallback)",
        })
      case "switch-mode":
        return Responses.switchModeRejected(query.id, "Mode switching not supported in CLI")
      case "create-plan":
        return Responses.createPlan(query.id, { decision: "success" })
      case "setup-vm-environment":
        return Responses.setupVmEnvironment(query.id, { decision: "success" })
      case "replace-environment":
        return Responses.replaceEnv(query.id, {
          decision: "failure",
          errorMessage: "Environment replacement is not supported in this environment",
          setupLogs: "",
        })
      case "pr-management":
        return Responses.prManagement(query.id, {
          decision: "error",
          error: "PR management is only available in cloud agents",
        })
      case "mcp-auth":
        return Responses.mcpAuthRejected(query.id, "MCP authentication is not supported in this environment")
      case "connect-scm":
        return Responses.connectScmRejected(query.id, "Connecting a source-control account is not supported here")
      case "generate-image": {
        const payload = query.payload as { readonly description?: string } | undefined
        return Responses.generateImageApproved(query.id, payload?.description)
      }
      default:
        throw new Error("Unhandled interaction query type: " + query.kind)
    }
  }
}

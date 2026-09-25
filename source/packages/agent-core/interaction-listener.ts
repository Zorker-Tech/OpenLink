/**
 * The channel an agent talks to its client through, and the fallback when there is no client.
 *
 * Everything an agent needs a decision on travels over this one interface: updates it sends out, and
 * questions it asks back. An environment without a client (a CLI, a test, a headless run) still has to
 * answer those questions, so the no-op listener answers each of them with the refusal or approval that
 * means "carry on without me" — and it is explicit about which ones it cannot support, because an agent
 * that believes a search was approved when it was not is worse than one that is told no.
 */

import { AskQuestionRejected, AskQuestionResult } from "../proto/generated/agent/v1/ask_question_tool_pb.ts"
import type { InteractionQuery, InteractionResponse } from "../proto/generated/agent/v1/agent_pb.ts"
import { CreatePlanResult, CreatePlanSuccess } from "../proto/generated/agent/v1/create_plan_tool_pb.ts"
import { PrManagementError, PrManagementResult } from "../proto/generated/agent/v1/pr_management_tool_pb.ts"
import { ReplaceEnvFailure, ReplaceEnvResult } from "../proto/generated/agent/v1/replace_env_tool_pb.ts"
import {
  SetupVmEnvironmentResult,
  SetupVmEnvironmentSuccess,
} from "../proto/generated/agent/v1/setup_vm_environment_tool_pb.ts"
import { Responses } from "./interaction-queries.ts"

export interface InteractionListenerContext {
  readonly canceled?: boolean
}

export interface InteractionListener<Context = InteractionListenerContext> {
  sendUpdate(context: Context, update: unknown): Promise<void>
  query(context: Context, query: InteractionQuery): Promise<InteractionResponse | undefined>
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

function prManagementUnavailable(): PrManagementResult {
  return new PrManagementResult({
    result: { case: "error", value: new PrManagementError({ error: "PR management is only available in cloud agents" }) },
  })
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

  async query(_context: Context, query: InteractionQuery): Promise<InteractionResponse> {
    switch (query.query.case) {
      case "webSearchRequestQuery":
        return Responses.webSearchApproved(query.id)
      case "webFetchRequestQuery":
        return Responses.webFetchApproved(query.id)
      case "askQuestionInteractionQuery":
        return Responses.askQuestion(query.id, new AskQuestionResult({
          result: {
            case: "rejected",
            value: new AskQuestionRejected({ reason: "Questions skipped by user (CLI fallback)" }),
          },
        }))
      case "switchModeRequestQuery":
        return Responses.switchModeRejected(query.id, "Mode switching not supported in CLI")
      case "createPlanRequestQuery":
        return Responses.createPlan(query.id, new CreatePlanResult({
          result: { case: "success", value: new CreatePlanSuccess() },
        }))
      case "setupVmEnvironmentArgs":
        return Responses.setupVmEnvironment(query.id, new SetupVmEnvironmentResult({
          result: { case: "success", value: new SetupVmEnvironmentSuccess({}) },
        }))
      case "replaceEnvArgs":
        return Responses.replaceEnv(query.id, new ReplaceEnvResult({
          result: {
            case: "failure",
            value: new ReplaceEnvFailure({
              errorMessage: "Environment replacement is not supported in this environment",
              setupLogs: "",
            }),
          },
        }))
      case "prManagementRequestQuery":
        return Responses.prManagement(query.id, prManagementUnavailable())
      case "mcpAuthRequestQuery":
        return Responses.mcpAuthRejected(query.id, "MCP authentication is not supported in this environment")
      case "connectScmRequestQuery":
        return Responses.connectScmRejected(query.id, "Connecting GitHub is not supported in this environment")
      case "generateImageRequestQuery":
        return Responses.generateImageApproved(query.id, query.query.value.args?.description)
      default:
        throw new Error("Unhandled interaction query type")
    }
  }
}

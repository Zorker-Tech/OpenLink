import {
  AgentMode,
  ExecutePlanInfo,
  ProjectDetails,
  SimulatedMsgReason,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TodoItem, TodoStatus } from "../proto/generated/agent/v1/todo_tool_pb.ts"
import { SelectedCodeSelection, SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts"
import { Position, Range } from "../proto/generated/agent/v1/utils_pb.ts"
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { toRedactedInteractionUpdate } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { toRedactedTodoItem } from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { readExecutorResource } from "../../../packages/agent-exec/read-operation.ts"
import { writeExecutorResource } from "../../../packages/agent-exec/write-operation.ts"
import { ReadArgs } from "../proto/generated/agent/v1/read_exec_pb.ts"
import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.ts"
import { Updates } from "../../../packages/agent-core/interaction-updates.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { todoStatusFromString } from "../../../packages/agent/tools/core/todo/common.ts"
import { toInteropTodoStatus } from "./todo-schema-adapter.ts"
import type {
  ExecutePlanPlanFileIO,
  PlanExecutionMessageInput,
  PlanExecutionMode,
  PlanExecutionRequest,
  PlanTodo,
} from "../../../packages/agent/actions/execute-plan-contracts.ts"
import {
  createSlatePlanRegistryEntry,
  type SlatePlanRegistryEntry,
} from "../../../packages/agent/goal-state.ts"

type Any = any

function decodeExecutionMode(value: unknown): PlanExecutionMode {
  if (value === undefined || value === AgentMode.UNSPECIFIED || value === AgentMode.AGENT) return "agent"
  if (value === AgentMode.ASK) return "ask"
  if (value === AgentMode.MULTITASK) return "multitask"
  return { kind: "unrecognized", value }
}

export function toInteropAgentMode(mode: PlanExecutionMode): AgentMode {
  if (mode === "agent") return AgentMode.AGENT
  if (mode === "ask") return AgentMode.ASK
  if (mode === "multitask") return AgentMode.MULTITASK
  return mode.value as AgentMode
}

/** Decodes the action's redacted fields into the values the plan policy reasons about. */
export function decodeExecutePlanAction(value: unknown): PlanExecutionRequest {
  const action: Any = value
  const planFileContent = action.planFileContent?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const planFilePath = action.planFilePath?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const planFileUri = action.planFileUri?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return {
    requestContext: action.requestContext === undefined
      ? undefined
      : fromRedactedRequestContext(action.requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
    planText: planFileContent,
    path: planFilePath,
    sourceUri: planFileUri,
    id: action.planId,
    messageId: action.kickoffMessageId,
    mode: decodeExecutionMode(action.executionMode),
    privacyMode: action._privacyMode as PrivacyMode | undefined,
  }
}

/** Builds the message the model receives and the matching redacted listener update. */
export function createPlanExecutionMessage(input: PlanExecutionMessageInput) {
  const lineCount = Math.max(1, input.planContent.split("\n").length)
  const selectedContext = new SelectedContext({
    codeSelections: [new SelectedCodeSelection({
      content: input.planContent,
      path: input.planPath,
      range: new Range({
        start: new Position({ line: 1, column: 0 }),
        end: new Position({ line: lineCount, column: 0 }),
      }),
    })],
  })
  const userMessage = new UserMessage({
    text: input.text,
    messageId: input.messageId,
    selectedContext,
    mode: toInteropAgentMode(input.executionMode),
    ...(input.rootProject ? { projectDetails: new ProjectDetails() } : {}),
    isSimulatedMsg: true,
    simulatedMsgReason: SimulatedMsgReason.PLAN_EXECUTION,
    ...(input.planId !== undefined && input.planId.length > 0
      ? { executePlanInfo: new ExecutePlanInfo({ planId: input.planId, planTitle: input.planTitle }) }
      : {}),
  })
  return {
    userMessage,
    listenerUpdate: toRedactedInteractionUpdate(
      Updates.userMessageAppended(userMessage),
      input.listenerPrivacyMode,
    ),
  }
}

/** Converts plan frontmatter todos into the redacted state entries used by the turn. */
export function toRedactedPlanTodos(todos: readonly PlanTodo[], privacyMode: PrivacyMode): unknown[] {
  return todos.map(todo => {
    const slateStatus = todoStatusFromString(todo.status)
    const status = slateStatus !== undefined && slateStatus !== "unspecified"
      ? toInteropTodoStatus(slateStatus)
      : TodoStatus.PENDING
    const item = new TodoItem({
      id: todo.id,
      content: todo.content,
      status,
      createdAt: BigInt(Date.now()),
      updatedAt: BigInt(Date.now()),
      dependencies: (todo.dependencies ?? []) as string[],
    })
    return toRedactedTodoItem(item, privacyMode)
  })
}

export function isInteropPlanTodoComplete(status: unknown): boolean {
  return status === TodoStatus.COMPLETED
}

export function createPlanRegistryEntry(id: string, path: string): SlatePlanRegistryEntry {
  return createSlatePlanRegistryEntry(id, path)
}

/** Adapts the host's file executor messages to the plan policy's read/restore port. */
export function createExecutePlanPlanFileIO(resourceAccessor: any): ExecutePlanPlanFileIO {
  return {
    async exists(context, path) {
      const result = await resourceAccessor.get(readExecutorResource).execute(
        context,
        new ReadArgs({ path, limit: 1 }),
      )
      return result.result.case === "success"
    },
    async restoreFile(context, path, content) {
      const result = await resourceAccessor.get(writeExecutorResource).execute(
        context,
        new WriteArgs({ path, fileText: content, returnFileContentAfterWrite: false }),
      )
      return result.result.case === "success"
    },
  }
}

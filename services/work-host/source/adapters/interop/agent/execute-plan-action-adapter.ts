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
import { toRedactedTodoItem } from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { readExecutorResource } from "../../../packages/agent-exec/read-operation.ts"
import { writeExecutorResource } from "../../../packages/agent-exec/write-operation.ts"
import { fromInteropUserMessage, slateUserMessageAppendedUpdate } from "./user-message-action-protocol-adapter.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { todoStatusFromString } from "../../../packages/agent/tools/core/todo/common.ts"
import {
  fromRedactedInteropTodoItem,
  toInteropTodoStatus,
} from "./todo-schema-adapter.ts"
import type { SlateTodoItem } from "../../../packages/agent/tools/core/todo/contracts.ts"
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
  if (value === undefined || value === AgentMode.UNSPECIFIED || value === AgentMode.AGENT || value === "agent") return "agent"
  if (value === AgentMode.ASK || value === "ask" || value === "chat") return "chat"
  if (value === AgentMode.MULTITASK || value === "multitask") return "multitask"
  return "unspecified"
}

export function toInteropAgentMode(mode: PlanExecutionMode): AgentMode {
  if (mode === "agent") return AgentMode.AGENT
  if (mode === "chat") return AgentMode.ASK
  if (mode === "multitask") return AgentMode.MULTITASK
  return AgentMode.UNSPECIFIED
}

/** Decodes only the request-context sidecar retained from a historical plan action. */
export function decodePlanRequestContext(value: unknown) {
  return fromRedactedRequestContext(value as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
}

/** Projects the historical plan action into Slate's versioned request contract. */
export function decodeExecutePlanAction(value: unknown): PlanExecutionRequest {
  const action: Any = value !== null && typeof value === "object" ? value : {}
  const planFileContent = action.planFileContent?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const planFilePath = action.planFilePath?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const planFileUri = action.planFileUri?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  const mode = decodeExecutionMode(action.executionMode)
  const requestContext = action.requestContext
  const legacyPayload = value !== null && typeof value === "object"
    ? value as Readonly<Record<string, unknown>>
    : undefined
  const compatibility = requestContext === undefined && legacyPayload === undefined
    ? undefined
    : {
        ...(requestContext === undefined ? {} : { requestContext }),
        ...(legacyPayload === undefined ? {} : { legacyPayload }),
      }
  return {
    schema: "slate.agent-action.execute-plan",
    version: 1,
    ...(planFileContent === undefined ? {} : { planText: planFileContent }),
    ...(planFilePath === undefined ? {} : { path: planFilePath }),
    ...(planFileUri === undefined ? {} : { sourceUri: planFileUri }),
    ...(action.planId === undefined ? {} : { id: action.planId }),
    ...(action.kickoffMessageId === undefined ? {} : { messageId: action.kickoffMessageId }),
    mode,
    ...(action._privacyMode === undefined ? {} : { privacyMode: action._privacyMode as PrivacyMode }),
    ...(compatibility === undefined ? {} : { compatibility }),
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
  const slateUserMessage = fromInteropUserMessage(userMessage)
  return {
    userMessage,
    slateUserMessage,
    listenerUpdate: slateUserMessageAppendedUpdate(slateUserMessage, input.listenerPrivacyMode),
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

/** Creates Slate-owned persisted todo records from the plan's domain items. */
export function toSlatePlanTodos(todos: readonly PlanTodo[], privacyMode: PrivacyMode): SlateTodoItem[] {
  return toRedactedPlanTodos(todos, privacyMode).map(todo =>
    fromRedactedInteropTodoItem(todo as Parameters<typeof fromRedactedInteropTodoItem>[0]),
  )
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
        { path, limit: 1 },
      )
      return result.kind === "success"
    },
    async restoreFile(context, path, content) {
      const result = await resourceAccessor.get(writeExecutorResource).execute(
        context,
        { path, text: content, includeContentAfterWrite: false },
      )
      return result.kind === "success"
    },
  }
}

/**
 * What a tool call was allowed to do, remembered across the interruption it survived.
 *
 * A pending tool call is one the conversation still owes an answer to, and the answer may be written in a
 * different turn — after a restart, or after the platform reconstructed the interruption. By then the
 * conversation's own state has moved on: the tools that were offered may have changed, and a dynamic
 * invocation that once named a tool may name nothing now. So what was decided when the call was admitted is
 * written down with the call: which tool it was, whether it came in through a dynamic namespace, and which
 * names were allowed to be called at all.
 *
 * Writing that down is what makes a replay safe. A replayed call is checked against what it was admitted
 * as, and a call that would now resolve to a different tool is answered with the mismatch rather than run —
 * because running something else under the same call id would put a result in the conversation for a call
 * the model never made. The contracts are stored on the carrier message itself, in the provider input the
 * platform already owns, so they travel with the conversation and need no separate store.
 */

import { DYNAMIC_TOOLS_NAMESPACE } from "../agent-exec/mcp-operations.ts"
import {
  getEffectiveToolCallArgs,
  getEffectiveToolCallName,
  parseNativeToolArguments,
  resolveEffectiveToolCallDescriptor,
  type NativeToolCallDescriptor,
} from "./tool-stream-executor.ts"
import {
  resolveToolCallIdentity,
  type ToolExecutionSet,
} from "./tools/tool-execution.ts"

interface ToolCallContentPart {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly args?: unknown
}

export interface PendingToolExecutionContract {
  readonly toolCallId: string
  readonly outerToolName: string
  readonly toolIdentifier: string
  readonly isDynamic: boolean
  readonly allowedToolNames: readonly string[]
  readonly effectiveToolName?: string | undefined
  readonly effectiveToolIdentifier?: string | undefined
}

interface ResolvedIdentity {
  readonly toolIdentifier: string
  readonly isDynamic: boolean
}

type IdentityResolver = (input: {
  readonly toolName: string
  readonly args: unknown
}) => ResolvedIdentity | undefined

interface ContractCarrier {
  readonly providerOptions?: {
    readonly slate?: {
      readonly pendingToolExecutionContracts?: unknown
    }
  }
}

function looksLikeToolCall(value: unknown): value is ToolCallContentPart {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const contentPart = value as Record<string, unknown>
  return contentPart.type === "tool-call" &&
    typeof contentPart.toolCallId === "string" &&
    typeof contentPart.toolName === "string"
}

function isNamedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** A stored contract is read back only if it is whole; a partial one would admit the wrong tool. */
function readContractShape(value: unknown): PendingToolExecutionContract | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const stored = value as Record<string, unknown>
  if (
    typeof stored.toolCallId !== "string" ||
    typeof stored.outerToolName !== "string" ||
    !isNamedIdentifier(stored.toolIdentifier) ||
    typeof stored.isDynamic !== "boolean" ||
    !Array.isArray(stored.allowedToolNames) ||
    !stored.allowedToolNames.every(name => typeof name === "string")
  ) {
    return undefined
  }
  const contract: PendingToolExecutionContract = {
    toolCallId: stored.toolCallId,
    outerToolName: stored.outerToolName,
    toolIdentifier: stored.toolIdentifier,
    isDynamic: stored.isDynamic,
    allowedToolNames: stored.allowedToolNames,
  }
  if (typeof stored.effectiveToolName === "string") {
    (contract as { effectiveToolName?: string }).effectiveToolName = stored.effectiveToolName
  }
  if (isNamedIdentifier(stored.effectiveToolIdentifier)) {
    (contract as { effectiveToolIdentifier?: string }).effectiveToolIdentifier =
      stored.effectiveToolIdentifier
  }
  return contract
}

export function readPendingToolExecutionContracts(
  message: ContractCarrier,
): Map<string, PendingToolExecutionContract> {
  const stored = message.providerOptions?.slate?.pendingToolExecutionContracts
  const contracts = new Map<string, PendingToolExecutionContract>()
  if (stored === undefined || stored === null || typeof stored !== "object") {
    return contracts
  }
  for (const [toolCallId, value] of Object.entries(stored)) {
    const contract = readContractShape(value)
    // A contract stored under the wrong key is not the contract for that call.
    if (contract === undefined || contract.toolCallId !== toolCallId) {
      continue
    }
    contracts.set(toolCallId, contract)
  }
  return contracts
}

export function buildPendingToolExecutionContract(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
  readonly resolveIdentity: IdentityResolver
  readonly toolExecutionSet: ToolExecutionSet
  readonly allowedToolNames: Iterable<string>
}): PendingToolExecutionContract {
  const resolvedDescriptor = resolveEffectiveToolCallDescriptor({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: parseNativeToolArguments(input.args) ?? {},
  }, input.toolExecutionSet)
  const outer = input.resolveIdentity({
    toolName: input.toolName,
    args: input.args,
  }) ?? {
    toolIdentifier: "unknown",
    isDynamic: false,
  }
  const innerName = resolvedDescriptor.effectiveNativeToolCall?.toolName
  const innerArgs = resolvedDescriptor.effectiveNativeToolCall?.args
  // An inner tool that resolves to nothing is still dynamic: it came in through a namespace.
  const innerIdentity = innerName === undefined
    ? undefined
    : input.resolveIdentity({
      toolName: innerName,
      args: innerArgs,
    }) ?? {
      toolIdentifier: "unknown",
      isDynamic: true,
    }
  return {
    toolCallId: input.toolCallId,
    outerToolName: input.toolName,
    toolIdentifier: outer.toolIdentifier,
    isDynamic: outer.isDynamic || innerIdentity?.isDynamic === true,
    ...(innerName !== undefined
      ? {
        effectiveToolName: innerName,
        effectiveToolIdentifier: innerIdentity?.toolIdentifier ?? "unknown",
      }
      : {}),
    allowedToolNames: [...input.allowedToolNames],
  }
}

/** The pending message with its contracts written onto it, and when the call started. */
export function enrichPendingToolCallJson(
  pendingJson: string,
  input: {
    readonly resolveIdentity: IdentityResolver
    readonly toolExecutionSet: ToolExecutionSet
    readonly allowedToolNames: Iterable<string>
    readonly pendingToolCallStartedAtMs?: number | undefined
  },
): string {
  try {
    const message = JSON.parse(pendingJson) as Record<string, unknown> & {
      content?: unknown
      providerOptions?: Record<string, unknown> & {
        slate?: Record<string, unknown>
      }
    }
    // Contracts already on the message are kept: an earlier turn's calls are still pending.
    const contracts: Record<string, unknown> = {
      ...(message.providerOptions?.slate?.pendingToolExecutionContracts as
        | Record<string, unknown>
        | undefined) ?? {},
    }
    if (Array.isArray(message.content)) {
      for (const contentPart of message.content) {
        if (!looksLikeToolCall(contentPart)) {
          continue
        }
        contracts[contentPart.toolCallId] = buildPendingToolExecutionContract({
          toolCallId: contentPart.toolCallId,
          toolName: contentPart.toolName,
          args: contentPart.args,
          resolveIdentity: input.resolveIdentity,
          toolExecutionSet: input.toolExecutionSet,
          allowedToolNames: input.allowedToolNames,
        })
      }
    }
    const previousStartedAtMs =
      message.providerOptions?.slate?.pendingToolCallStartedAtMs
    message.providerOptions = {
      ...message.providerOptions,
      slate: {
        ...message.providerOptions?.slate,
        // A call that already has a start time keeps it; the first one is the truth.
        ...(input.pendingToolCallStartedAtMs !== undefined
          ? {
            pendingToolCallStartedAtMs:
              previousStartedAtMs ?? input.pendingToolCallStartedAtMs,
          }
          : {}),
        pendingToolExecutionContracts: contracts,
      },
    }
    return JSON.stringify(message)
  } catch {
    // A message that cannot be read is left as it was rather than replaced by a broken one.
    return pendingJson
  }
}

/** The inner tool a dynamic call would run, which is only admitted when the call itself was. */
export function getAdmittedEffectiveToolName(
  descriptor: NativeToolCallDescriptor,
  allowedToolNames: ReadonlySet<string> | undefined,
): string | undefined {
  return descriptor.effectiveNativeToolCall !== undefined &&
      allowedToolNames?.has(descriptor.toolName) === true
    ? descriptor.effectiveNativeToolCall.toolName
    : undefined
}

/** Which names the pending calls together admit, both the outer calls and what they would run. */
export function collectPendingToolAdmission(input: {
  readonly contracts: Iterable<PendingToolExecutionContract>
}): {
  readonly allowedToolNames: Set<string> | undefined
  readonly admittedEffectiveToolNames: Set<string>
} {
  const admittedEffectiveToolNames = new Set<string>()
  let allowedToolNames: Set<string> | undefined
  for (const contract of input.contracts) {
    allowedToolNames ??= new Set(contract.allowedToolNames)
    for (const name of contract.allowedToolNames) {
      allowedToolNames.add(name)
    }
    admittedEffectiveToolNames.add(contract.outerToolName)
    // The inner tool is admitted only when its own namespace call was allowed.
    if (
      contract.effectiveToolName !== undefined &&
      allowedToolNames.has(contract.outerToolName)
    ) {
      admittedEffectiveToolNames.add(contract.effectiveToolName)
    }
  }
  return { allowedToolNames, admittedEffectiveToolNames }
}

/** A replayed call resolves the way it was admitted to, rather than the way the session now looks. */
export function resolveDescriptorForPendingToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
  readonly contract?: PendingToolExecutionContract | undefined
  readonly toolExecutionSet: ToolExecutionSet
}): NativeToolCallDescriptor {
  const replayedDescriptor: NativeToolCallDescriptor = {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: parseNativeToolArguments(input.args) ?? {},
  }
  if (
    input.contract?.effectiveToolName !== undefined &&
    replayedDescriptor.args !== null &&
    typeof replayedDescriptor.args === "object" &&
    !Array.isArray(replayedDescriptor.args)
  ) {
    const outerArguments = replayedDescriptor.args as Record<string, unknown>
    // The stored contract names the inner tool, so the nested arguments are read from the outer call.
    const nestedArguments =
      outerArguments.namespace === DYNAMIC_TOOLS_NAMESPACE &&
        outerArguments.toolName === input.contract.effectiveToolName
        ? parseNativeToolArguments(outerArguments.arguments)
        : undefined
    if (nestedArguments !== undefined) {
      return {
        ...replayedDescriptor,
        effectiveNativeToolCall: {
          toolName: input.contract.effectiveToolName,
          args: nestedArguments,
        },
      }
    }
  }
  return resolveEffectiveToolCallDescriptor(replayedDescriptor, input.toolExecutionSet)
}

function expectedIdentifierFor(contract: PendingToolExecutionContract): string {
  return contract.effectiveToolIdentifier ?? contract.toolIdentifier
}

/**
 * Whether a replayed call is still the call that was admitted.
 *
 * Both halves are checked: the inner tool has to resolve, and the tool the call would actually run has to
 * be the one that was written down. A call that fails either check is answered with the mismatch instead of
 * being run, since a result for a call the model did not make is worse than an unanswered one.
 */
export function validatePendingToolContractIdentity(input: {
  readonly contract: PendingToolExecutionContract
  readonly descriptor: NativeToolCallDescriptor
  readonly tool: Record<string, unknown>
  readonly directDynamicToolNames: ReadonlySet<string>
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (
    input.contract.effectiveToolName !== undefined &&
    input.descriptor.effectiveNativeToolCall === undefined
  ) {
    return {
      ok: false,
      reason:
        `Pending tool contract mismatch for ${input.descriptor.toolName}: expected effective tool ${input.contract.effectiveToolName}, but none resolved`,
    }
  }
  const innerName = getEffectiveToolCallName(input.descriptor)
  const innerArgs = getEffectiveToolCallArgs(input.descriptor)
  const actualIdentity = resolveToolCallIdentity({
    tool: input.tool,
    args: innerArgs,
    isDirectDynamicTool:
      input.descriptor.effectiveNativeToolCall !== undefined ||
      input.directDynamicToolNames.has(innerName),
  })
  const expectedIdentifier = expectedIdentifierFor(input.contract)
  if (actualIdentity.toolIdentifier !== expectedIdentifier) {
    return {
      ok: false,
      reason:
        `Pending tool contract mismatch for ${innerName}: expected ${expectedIdentifier}, got ${String(actualIdentity.toolIdentifier)}`,
    }
  }
  return { ok: true }
}

/** The answer a mismatched call gets: the reason, in the shape a tool result takes. */
export function createPendingToolContractMismatchResult(
  descriptor: NativeToolCallDescriptor,
  reason: string,
): Record<string, unknown> {
  return {
    role: "tool",
    id: descriptor.toolCallId,
    content: [{
      type: "tool-result",
      toolName: descriptor.toolName,
      toolCallId: descriptor.toolCallId,
      result: reason,
    }],
  }
}
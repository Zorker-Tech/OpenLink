/** Slate's durable shell operation value, shared by tool execution and conversation steps. */

import { isRedactedString, type RedactedString } from "../redaction/redacted-values.ts"
import type { ShellExecResponse, ShellExecutorArgs } from "../agent-exec/shell.ts"

type SlateShellTextProjection<Value, Text extends string | RedactedString> =
  Value extends RedactedString ? RedactedString
    : Value extends string ? string extends Value ? Text : Value
      : Value extends Uint8Array ? Value
        : Value extends readonly (infer Entry)[] ? readonly SlateShellTextProjection<Entry, Text>[]
          : Value extends object ? { readonly [Key in keyof Value]: Key extends "kind" | "type" | "suggestedSandboxMode"
              ? Value[Key]
              : SlateShellTextProjection<Value[Key], Text> }
            : Value

export type SlateShellToolCall<Text extends string | RedactedString = string> = SlateShellTextProjection<{
  readonly kind: "shell"
  readonly args?: ShellExecutorArgs
  readonly result?: ShellExecResponse
}, Text>

export type SlateShellToolCallText = string | RedactedString

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function isText(value: unknown): value is SlateShellToolCallText {
  return typeof value === "string" || isRedactedString(value)
}

function isOptional(value: unknown, predicate: (value: unknown) => boolean): boolean {
  return value === undefined || predicate(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
}

function isTextArray(value: unknown): value is readonly SlateShellToolCallText[] {
  return Array.isArray(value) && value.every(isText)
}

function isUnknownEnum(value: unknown): value is { readonly kind: "unknown"; readonly code: number } {
  return isRecord(value) && hasOnlyOwnKeys(value, ["kind", "code"]) && value.kind === "unknown" &&
    isInt32(value.code)
}

function isKnownOrUnknown<Known extends string>(value: unknown, known: readonly Known[]): value is Known | { readonly kind: "unknown"; readonly code: number } {
  return (typeof value === "string" && known.includes(value as Known)) || isUnknownEnum(value)
}

function isShellParsing(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyOwnKeys(value, [
    "failed", "executableCommands", "hasRedirects", "hasCommandSubstitution", "allRedirectsAreDevNull", "redirects",
  ]) || typeof value.failed !== "boolean" || typeof value.hasRedirects !== "boolean" ||
      typeof value.hasCommandSubstitution !== "boolean" ||
      !isOptional(value.allRedirectsAreDevNull, candidate => typeof candidate === "boolean") ||
      !Array.isArray(value.executableCommands) || !Array.isArray(value.redirects)) return false
  if (!value.executableCommands.every(command => isRecord(command) &&
      hasOnlyOwnKeys(command, ["name", "fullText", "arguments"]) && isText(command.name) &&
      isText(command.fullText) && Array.isArray(command.arguments) &&
      command.arguments.every(argument => isRecord(argument) && hasOnlyOwnKeys(argument, ["type", "value"]) &&
        isText(argument.type) && isText(argument.value)))) return false
  return value.redirects.every(redirect => isRecord(redirect) &&
    hasOnlyOwnKeys(redirect, ["operator", "destinationFileDescriptors", "targetNodeType", "targetText"]) &&
    isText(redirect.operator) && Array.isArray(redirect.destinationFileDescriptors) &&
    redirect.destinationFileDescriptors.every(Number.isInteger) && isText(redirect.targetNodeType) &&
    isOptional(redirect.targetText, isText))
}

function isNetworkPolicy(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyOwnKeys(value, ["version", "default", "deny", "allow", "logging"]) ||
      !isOptional(value.version, Number.isInteger) ||
      !isOptional(value.default, candidate => candidate === "allow" || candidate === "deny") ||
      !isOptional(value.deny, isTextArray) || !isOptional(value.allow, isTextArray)) return false
  if (value.logging === undefined) return true
  return isRecord(value.logging) && hasOnlyOwnKeys(value.logging, ["decisionLogPath", "logFormat"]) &&
    isOptional(value.logging.decisionLogPath, isText) && isOptional(value.logging.logFormat, isText)
}

function isSandboxRule(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyOwnKeys(value, [
    "type", "networkPolicy", "skipStatsigDefaults", "additionalReadwritePaths", "additionalReadonlyPaths",
    "disableTmpWrite", "enableSharedBuildCache", "debugOutputDir", "captureDenies", "networkPolicyStrict",
    "readBoundary", "additionalReadPaths", "allowlistEscalated", "ignoreMapping",
  ]) || !["insecure_none", "workspace_readwrite", "workspace_readonly"].includes(value.type as string) ||
      !isOptional(value.networkPolicy, isNetworkPolicy) ||
      !isOptional(value.skipStatsigDefaults, candidate => typeof candidate === "boolean") ||
      !isOptional(value.additionalReadwritePaths, isTextArray) ||
      !isOptional(value.additionalReadonlyPaths, isTextArray) ||
      !isOptional(value.disableTmpWrite, candidate => typeof candidate === "boolean") ||
      !isOptional(value.enableSharedBuildCache, candidate => typeof candidate === "boolean") ||
      !isOptional(value.debugOutputDir, isText) ||
      !isOptional(value.captureDenies, candidate => typeof candidate === "boolean") ||
      !isOptional(value.networkPolicyStrict, candidate => typeof candidate === "boolean") ||
      !isOptional(value.readBoundary, candidate => candidate === "system" || candidate === "workspace") ||
      !isOptional(value.additionalReadPaths, isTextArray) ||
      !isOptional(value.allowlistEscalated, candidate => typeof candidate === "boolean")) return false
  return true
}

function isClassifierResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === "classification-failed") return hasOnlyOwnKeys(value, ["kind"])
  if (value.kind !== "classification-succeeded" || !hasOnlyOwnKeys(value, ["kind", "suggestedSandboxMode", "commands"]) ||
      typeof value.suggestedSandboxMode !== "string" || !Array.isArray(value.commands)) return false
  return value.commands.every(command => isRecord(command) &&
    hasOnlyOwnKeys(command, ["name", "arguments", "suggestedAllowlistEntry", "subcommandTokens"]) &&
    isText(command.name) && isTextArray(command.arguments) && isText(command.suggestedAllowlistEntry) &&
    isTextArray(command.subcommandTokens))
}

function isOutputNotification(value: unknown): boolean {
  return isRecord(value) && hasOnlyOwnKeys(value, ["pattern", "reason", "notificationLimit", "debounceSeconds"]) &&
    isText(value.pattern) && isText(value.reason) &&
    isOptional(value.notificationLimit, Number.isInteger) && isOptional(value.debounceSeconds, isFiniteNumber)
}

function isSmartModeApproval(value: unknown): boolean {
  return isRecord(value) && hasOnlyOwnKeys(value, ["reason", "requestId"]) &&
    isOptional(value.reason, isText) && isOptional(value.requestId, isText)
}

function isHookApprovalRequirement(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === "force-prompt") {
    return hasOnlyOwnKeys(value, ["kind", "reason"]) && isOptional(value.reason, isText)
  }
  return value.kind === "unknown" && hasOnlyOwnKeys(value, ["kind", "code", "reason"]) &&
    isInt32(value.code) &&
    isOptional(value.reason, isText)
}

function isShellArguments(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyOwnKeys(value, [
    "command", "workingDirectory", "timeout", "toolCallId", "simpleCommands", "hasInputRedirect", "hasOutputRedirect",
    "parsing", "requestedSandboxPolicy", "fileOutputThresholdBytes", "isBackground", "skipApproval", "timeoutBehavior",
    "hardTimeout", "description", "classifierResult", "closeStdin", "outputNotification", "smartModeApproval",
    "hookApprovalRequirement", "conversationId", "adminCommandDenylist",
  ]) || !isText(value.command) || !isOptional(value.workingDirectory, isText) ||
      !isOptional(value.timeout, isFiniteNumber) || !isOptional(value.toolCallId, isText) ||
      !isOptional(value.simpleCommands, isTextArray) ||
      !isOptional(value.hasInputRedirect, candidate => typeof candidate === "boolean") ||
      !isOptional(value.hasOutputRedirect, candidate => typeof candidate === "boolean") ||
      !isOptional(value.parsing, isShellParsing) ||
      !isOptional(value.requestedSandboxPolicy, isSandboxRule) ||
      !isOptional(value.fileOutputThresholdBytes, candidate => typeof candidate === "bigint") ||
      !isOptional(value.isBackground, candidate => typeof candidate === "boolean") ||
      !isOptional(value.skipApproval, candidate => typeof candidate === "boolean") ||
      !isOptional(value.hardTimeout, isFiniteNumber) || !isOptional(value.description, isText) ||
      !isOptional(value.classifierResult, isClassifierResult) ||
      !isOptional(value.closeStdin, candidate => typeof candidate === "boolean") ||
      !isOptional(value.outputNotification, isOutputNotification) ||
      !isOptional(value.smartModeApproval, isSmartModeApproval) ||
      !isOptional(value.hookApprovalRequirement, isHookApprovalRequirement) ||
      !isOptional(value.conversationId, isText) || !isOptional(value.adminCommandDenylist, isTextArray)) return false
  if (value.timeoutBehavior === undefined || value.timeoutBehavior === "foreground" || value.timeoutBehavior === "background") return true
  return isUnknownEnum(value.timeoutBehavior)
}

function isShellOutputLocation(value: unknown): boolean {
  return isRecord(value) && hasOnlyOwnKeys(value, ["filePath", "sizeBytes", "lineCount"]) &&
    isText(value.filePath) && typeof value.sizeBytes === "bigint" && typeof value.lineCount === "bigint"
}

function isShellResultFields(value: Record<string, unknown>): boolean {
  return isText(value.command) && isText(value.workingDirectory) && isFiniteNumber(value.exitCode) &&
    isText(value.signal) && isText(value.stdout) && isText(value.stderr) && isFiniteNumber(value.executionTimeMs) &&
    isOptional(value.outputFile, isShellOutputLocation) && isOptional(value.interleavedOutput, isText) &&
    isOptional(value.processId, Number.isInteger) && isOptional(value.waitedMs, isFiniteNumber) &&
    isOptional(value.localExecutionTimeMs, isFiniteNumber) && isOptional(value.outputHead, isText) &&
    isOptional(value.outputTail, isText) && isOptional(value.elidedCharacters, Number.isInteger)
}

function isShellOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "success":
      return hasOnlyOwnKeys(value, [
        "kind", "command", "workingDirectory", "exitCode", "signal", "stdout", "stderr", "executionTimeMs", "outputFile",
        "interleavedOutput", "processId", "waitedMs", "localExecutionTimeMs", "outputHead", "outputTail", "elidedCharacters",
        "shellId", "backgroundReason",
      ]) && isShellResultFields(value) && isOptional(value.shellId, Number.isInteger) &&
        isOptional(value.backgroundReason, reason => isKnownOrUnknown(reason, ["user", "timeout"]))
    case "failure":
      return hasOnlyOwnKeys(value, [
        "kind", "command", "workingDirectory", "exitCode", "signal", "stdout", "stderr", "executionTimeMs", "outputFile",
        "interleavedOutput", "processId", "waitedMs", "localExecutionTimeMs", "outputHead", "outputTail", "elidedCharacters",
        "aborted", "abortReason",
      ]) && isShellResultFields(value) && typeof value.aborted === "boolean" &&
        isOptional(value.abortReason, reason => isKnownOrUnknown(reason, ["user-abort", "timeout"]))
    case "timeout":
      return hasOnlyOwnKeys(value, ["kind", "command", "workingDirectory", "timeoutMs"]) &&
        isText(value.command) && isText(value.workingDirectory) && isFiniteNumber(value.timeoutMs)
    case "rejected":
      return hasOnlyOwnKeys(value, ["kind", "command", "workingDirectory", "reason", "isReadonly"]) &&
        isText(value.command) && isText(value.workingDirectory) && isText(value.reason) && typeof value.isReadonly === "boolean"
    case "spawn-error":
      return hasOnlyOwnKeys(value, ["kind", "command", "workingDirectory", "message"]) &&
        isText(value.command) && isText(value.workingDirectory) && isText(value.message)
    case "permission-denied":
      return hasOnlyOwnKeys(value, ["kind", "command", "workingDirectory", "message", "isReadonly"]) &&
        isText(value.command) && isText(value.workingDirectory) && isText(value.message) && typeof value.isReadonly === "boolean"
    case "unrecognized":
      return hasOnlyOwnKeys(value, ["kind"])
    default:
      return false
  }
}

function isShellResult(value: unknown): boolean {
  return isRecord(value) && hasOnlyOwnKeys(value, ["outcome", "sandboxPolicy", "isBackground", "terminalsFolder", "processId"]) &&
    isShellOutcome(value.outcome) && isOptional(value.sandboxPolicy, isSandboxRule) &&
    isOptional(value.isBackground, candidate => typeof candidate === "boolean") &&
    isOptional(value.terminalsFolder, isText) && isOptional(value.processId, Number.isInteger)
}

/** Validates the durable Slate operation before it enters a conversation step or a new storage envelope. */
export function isSlateShellToolCall(value: unknown): value is SlateShellToolCall<SlateShellToolCallText> {
  if (!isRecord(value) || !hasOnlyOwnKeys(value, ["kind", "args", "result"]) || value.kind !== "shell") return false
  return isOptional(value.args, isShellArguments) && isOptional(value.result, isShellResult)
}

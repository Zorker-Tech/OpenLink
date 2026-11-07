import type { SlateComputerUseExecutorRequest } from "../../../packages/agent/conversation-step-state.ts";

/** Projects the command text needed for Slate auditing out of an executor request. */
export function shellCommandForAudit(args: unknown): string {
  if (typeof args !== "object" || args === null || !("command" in args)) return "";
  return typeof args.command === "string" ? args.command : "";
}

/** Projects the operation label needed for desktop auditing without exposing its wire request type. */
export function computerUseActionForAudit(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("actions" in args) || !Array.isArray(args.actions)) return undefined;
  const first = args.actions[0] as unknown;
  if (typeof first !== "object" || first === null || !("kind" in first) || typeof first.kind !== "string") return undefined;
  return first.kind as SlateComputerUseExecutorRequest["actions"][number]["kind"];
}

import type { ComputerUseArgs } from "../proto/generated/agent/v1/computer_use_tool_pb.ts";

/** Projects the command text needed for Slate auditing out of an executor request. */
export function shellCommandForAudit(args: unknown): string {
  if (typeof args !== "object" || args === null || !("command" in args)) return "";
  return typeof args.command === "string" ? args.command : "";
}

/** Projects the operation label needed for desktop auditing without exposing its wire request type. */
export function computerUseActionForAudit(args: unknown): string | undefined {
  const request = args as ComputerUseArgs | undefined;
  return request?.actions[0]?.action.case;
}

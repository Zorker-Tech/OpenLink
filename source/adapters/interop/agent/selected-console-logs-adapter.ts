import type { SelectedConsoleLog } from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { ConsoleLogPromptInput } from "../../../packages/agent/context/console-logs-context.ts";

export function toConsoleLogPromptInputs(logs: readonly SelectedConsoleLog[]): ConsoleLogPromptInput[] {
  return logs.map(log => ({
    level: log.level,
    timestamp: log.timestamp,
    message: log.message,
  }));
}

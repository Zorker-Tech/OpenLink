import { clampLine } from "../shared/slate-text.ts";
import {
  MAX_ACTIVITY_DETAIL_CHARS,
  SLATE_BOX_AWAIT_SHELL_TOOL_NAME,
  SLATE_BOX_READ_TOOL_NAME,
  SLATE_BOX_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_READ_TOOL_NAME,
  SLATE_EXTERNAL_SHELL_TOOL_NAME,
  type ActivityUpdate,
  type AgentActivity,
} from "./slate-activity-contracts.ts";
import { extractShellEditTarget, fileBasename, parseArgsJson, urlHostname } from "./slate-activity-shell-paths.ts";

function stringArgument(args: Record<string, unknown> | null, key: string): string | undefined {
  const value = args?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function withDetail(detail: string | undefined): { detail: string } | {} {
  return detail ? { detail: clampLine(detail, MAX_ACTIVITY_DETAIL_CHARS) } : {};
}

function withTarget(target: string | undefined): { target: string } | {} {
  return target ? { target } : {};
}

interface ToolPresentation {
  readonly tool: string;
  readonly detail: string | undefined;
  readonly target: string | undefined;
}

function show(tool: string, detail?: string, target?: string): ToolPresentation {
  return { tool, detail, target };
}

function shellPresentation(name: string, args: Record<string, unknown> | null): ToolPresentation {
  const command = stringArgument(args, "command") ?? "";
  if (name === "shellToolCall" || name === SLATE_BOX_SHELL_TOOL_NAME) {
    return show(SLATE_BOX_SHELL_TOOL_NAME, extractShellEditTarget(command));
  }
  return show(name, extractShellEditTarget(command));
}

function readPresentation(name: string, args: Record<string, unknown> | null): ToolPresentation {
  const path = fileBasename(stringArgument(args, "path"));
  if (name === "readToolCall" || name === SLATE_BOX_READ_TOOL_NAME) {
    return show(SLATE_BOX_READ_TOOL_NAME, path);
  }
  return show(name, path);
}

function presentationFor(name: string, args: Record<string, unknown> | null, summary: string | undefined): ToolPresentation {
  switch (name) {
    case "shellToolCall":
    case SLATE_BOX_SHELL_TOOL_NAME:
    case SLATE_EXTERNAL_SHELL_TOOL_NAME:
      return shellPresentation(name, args);
    case "readToolCall":
    case SLATE_BOX_READ_TOOL_NAME:
    case SLATE_EXTERNAL_READ_TOOL_NAME:
      return readPresentation(name, args);
    case "webSearchToolCall":
      return show("WebSearch", stringArgument(args, "searchTerm"));
    case "webFetchToolCall":
      return show("WebFetch", urlHostname(stringArgument(args, "url")));
    case "generateImageToolCall":
      return show("GenerateImage", stringArgument(args, "description"));
    case "mcpToolCall":
      return show("CallMcpTool", stringArgument(args, "providerIdentifier") ?? stringArgument(args, "serverIdentifier"));
    case "getMcpToolsToolCall":
      return show("GetMcpTools", stringArgument(args, "server"));
    case "mcpAuthToolCall":
      return show("McpAuth", stringArgument(args, "serverIdentifier"));
    case "awaitToolCall":
    case SLATE_BOX_AWAIT_SHELL_TOOL_NAME:
      return show(SLATE_BOX_AWAIT_SHELL_TOOL_NAME);
    case SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME:
      return show(SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME);
    case "computerUseToolCall":
      return show("Computer");
    case "Task":
      return show("Task", summary);
    case "communicateUpdateToolCall": {
      const payload = parseArgsJson(stringArgument(args, "currentStep"));
      if (payload?.__slate_tool__ !== true) return show(name);
      return show(
        stringArgument(payload, "tool") ?? name,
        stringArgument(payload, "detail"),
        stringArgument(payload, "target"),
      );
    }
    default:
      return show(name);
  }
}

/** Project a tool call to the short label and bounded detail shown beside the agent. */
export function deriveToolCallActivity(
  input: Extract<ActivityUpdate, { type: "tool-call" }>,
): AgentActivity {
  const args = parseArgsJson(input.args);
  const display = presentationFor(input.name, args, input.summary);
  return {
    kind: "tool",
    tool: display.tool,
    ...withDetail(display.detail),
    ...withTarget(display.target),
    callId: input.id,
  };
}

/**
 * What to do with an MCP tool's output when it is too large to hand back.
 *
 * A server's answer can be enormous, and the conversation cannot carry it. So above a threshold the text is
 * written to a file in the project and the result is rewritten to point at it — the model keeps access to
 * everything without the turn paying for it. A result that already points at a file is left alone: the
 * server made that decision, and there is nothing to spill.
 *
 * Writing can fail, and the fallback is not the same as success: the text is cut to the inline limit with a
 * notice saying how large the whole output was and that the remainder is gone, because a model that cannot
 * see the rest should be told rather than left to assume it saw everything. The two outcomes are counted
 * apart, with the reason a spill failed recorded, since "there was nowhere to write" and "the write failed"
 * are different problems for the platform.
 *
 * Cutting is done on bytes rather than characters, and a cut that lands inside a multi-byte character drops
 * the partial one rather than leaving a replacement character in the middle of the text.
 */

import type { Context } from "../../../context/context.ts";
import {
  MCP_TEXT_FILE_THRESHOLD_BYTES,
  materializeMcpTextOutput,
  writeToAgentToolsFile,
} from "../../../agent-exec/agent-tools-file.ts";
import { writeExecutorResource, type WriteExecutor } from "../../../agent-exec/write-operation.ts";
import { McpTextContent, McpToolResultContentItem, type McpResult } from "../../../proto/generated/agent/v1/mcp_exec_pb.ts";
import { emitMcpOutputSpillOutcome } from "../../utils/mcp-metrics.ts";

interface ResourceAccessor {
  get(resource: typeof writeExecutorResource): WriteExecutor;
}

export async function spillLargeMcpTextOutput({
  ctx,
  result,
  resourceAccessor,
  projectDir,
  osPlatform,
  toolCallId,
}: {
  readonly ctx: Context;
  readonly result: McpResult;
  readonly resourceAccessor: ResourceAccessor;
  readonly projectDir: string | undefined;
  readonly osPlatform: string | undefined;
  readonly toolCallId: string;
}): Promise<McpResult> {
  if (result.result.case !== "success") {
    return result;
  }
  let spillAttempted = false;
  let failureReason = "write_failed";
  const content = await materializeMcpTextOutput({
    contentItems: result.result.value.content,
    thresholdBytes: MCP_TEXT_FILE_THRESHOLD_BYTES,
    write: async (aggregateText) => {
      spillAttempted = true;
      if (projectDir === undefined) {
        failureReason = "no_project_dir";
        return undefined;
      }
      try {
        return await writeToAgentToolsFile(ctx, resourceAccessor.get(writeExecutorResource), {
          content: aggregateText,
          projectDir,
          osPlatform,
          toolCallId,
        });
      } catch {
        return undefined;
      }
    },
  });
  if (!spillAttempted) {
    return result;
  }
  if (content !== undefined) {
    emitMcpOutputSpillOutcome(ctx, "spilled");
    const spilledResult = result.clone();
    if (spilledResult.result.case === "success") {
      spilledResult.result.value.content = content;
    }
    return spilledResult;
  }
  emitMcpOutputSpillOutcome(ctx, failureReason);
  const truncatedResult = result.clone();
  if (truncatedResult.result.case === "success") {
    truncatedResult.result.value.content = buildTruncatedInlineContent(truncatedResult.result.value.content);
  }
  return truncatedResult;
}

function buildTruncatedInlineContent(contentItems: readonly McpToolResultContentItem[]): McpToolResultContentItem[] {
  const aggregateText = contentItems.filter(item =>
    item.content.case === "text" && item.content.value.outputLocation === undefined
  ).map(item => item.content.case === "text" ? item.content.value.text : "").join("\n\n");
  const materializedItems: McpToolResultContentItem[] = [];
  let emittedTruncatedItem = false;
  for (const item of contentItems) {
    const isInlineText = item.content.case === "text" && item.content.value.outputLocation === undefined;
    if (!isInlineText) {
      materializedItems.push(item);
      continue;
    }
    if (!emittedTruncatedItem) {
      materializedItems.push(new McpToolResultContentItem({
        content: {
          case: "text",
          value: new McpTextContent({
            text: buildTruncatedTextWithNotice(aggregateText),
          }),
        },
      }));
      emittedTruncatedItem = true;
    }
  }
  return materializedItems;
}

function buildTruncatedTextWithNotice(text: string): string {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const truncatedText = truncateUtf8(text, MCP_TEXT_FILE_THRESHOLD_BYTES);
  const notice = `

[Output truncated: the full MCP tool output was ${totalBytes} bytes, which exceeds the inline limit of ${MCP_TEXT_FILE_THRESHOLD_BYTES} bytes, and could not be written to a file. The remainder was discarded; do not retry the same call expecting the full output.]`;
  return truncatedText + notice;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, maxBytes));
  return decoded.endsWith("\uFFFD") ? decoded.slice(0, -1) : decoded;
}

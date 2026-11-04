/**
 * Where a tool's output goes when it is too large for a message: written to a file, and described to the model by where it went.
 *
 * A tool that produces more than a message should carry writes the rest to a file and tells the model where it went, which is what lets a large result stay reachable without being pasted. Two thresholds decide that, one for text and a larger one for the MCP output that tends to be the bulk of a call, and the description the model is given names the file, its size and its line count so the reader can decide whether to open it.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Context } from "../../../packages/context/context.ts";
import { McpTextContent, McpToolResultContentItem } from "../proto/generated/agent/v1/mcp_exec_pb.ts";
import { OutputLocation, type OutputLocation as OutputLocationMessage } from "../proto/generated/agent/v1/utils_pb.ts";
import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.ts";
import type { WriteExecutor } from "../../../packages/agent-exec/write-operation.ts";

const AGENT_TOOLS_DIR = "agent-tools";
const MAX_OUTPUT_FILE_SIZE = 1024 * 1024 * 50;
export const AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES = 2e4;

export async function materializeMcpTextOutput({
  contentItems,
  thresholdBytes,
  write,
}: {
  readonly contentItems: McpToolResultContentItem[];
  readonly thresholdBytes: number;
  readonly write: (aggregateText: string) => Promise<OutputLocationMessage | undefined>;
}): Promise<McpToolResultContentItem[] | undefined> {
  const inlineTextItems = contentItems.filter(item =>
    item.content.case === "text" && item.content.value.outputLocation === undefined
  );
  const aggregateText = inlineTextItems.map(item =>
    item.content.case === "text" ? item.content.value.text : ""
  ).join("\n\n");
  if (thresholdBytes <= 0 || Buffer.byteLength(aggregateText, "utf8") <= thresholdBytes) {
    return contentItems;
  }
  const outputLocation = await write(aggregateText);
  if (outputLocation === undefined) {
    return undefined;
  }
  const materializedItems: McpToolResultContentItem[] = [];
  let emittedOutputLocation = false;
  for (const item of contentItems) {
    const isInlineText = item.content.case === "text" && item.content.value.outputLocation === undefined;
    if (!isInlineText) {
      materializedItems.push(item);
      continue;
    }
    if (!emittedOutputLocation) {
      materializedItems.push(new McpToolResultContentItem({
        content: {
          case: "text",
          value: new McpTextContent({ text: "", outputLocation }),
        },
      }));
      emittedOutputLocation = true;
    }
  }
  return materializedItems;
}

export async function writeToAgentToolsFile(
  ctx: Context,
  writeExecutor: WriteExecutor,
  {
    content,
    projectDir,
    osPlatform,
    toolCallId,
    maxSize,
  }: {
    readonly content: string;
    readonly projectDir: string;
    readonly osPlatform: string | undefined;
    readonly toolCallId: string;
    readonly maxSize?: number;
  },
): Promise<OutputLocationMessage | undefined> {
  const contentToWrite = content.slice(0, maxSize ?? MAX_OUTPUT_FILE_SIZE);
  const joinFn = osPlatform === "win32" ? path.win32.join : path.posix.join;
  const filePath = joinFn(projectDir, AGENT_TOOLS_DIR, `${randomUUID()}.txt`);
  const lineCount = contentToWrite.split("\n").length;
  const sizeBytes = Buffer.byteLength(contentToWrite, "utf8");
  const result = await writeExecutor.execute(ctx, new WriteArgs({
    path: filePath,
    fileText: contentToWrite,
    toolCallId,
  }));
  switch (result.result.case) {
    case "success":
      return new OutputLocation({
        filePath: result.result.value.path,
        sizeBytes: BigInt(sizeBytes),
        lineCount: BigInt(lineCount),
      });
    case "permissionDenied":
    case "noSpace":
    case "error":
    case "rejected":
    case undefined:
      return undefined;
    default: {
      const _exhaustive: never = result.result;
      throw new Error(`Unhandled result case: ${_exhaustive}`);
    }
  }
}

function formatOutputLocationSize(sizeBytes: bigint): string {
  const total = Number(sizeBytes);
  return total >= 1024 ? `${(total / 1024).toFixed(1)} KB` : `${total} bytes`;
}

export function describeOutputLocation(
  loc: OutputLocationMessage,
  opts?: { readonly leadText?: string },
): string {
  const lead = opts?.leadText ?? "Content";
  return `${lead} written to file: ${loc.filePath}\nSize: ${formatOutputLocationSize(loc.sizeBytes)}, ${loc.lineCount} lines`;
}

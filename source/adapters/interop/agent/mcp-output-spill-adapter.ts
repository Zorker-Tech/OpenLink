import type { Context } from "../../../packages/context/context.ts"
import {
  MCP_TEXT_FILE_THRESHOLD_BYTES,
  buildTruncatedMcpOutputText,
} from "../../../packages/agent/tools/mcp/mcp-output-spill-policy.ts"
import { writeExecutorResource, type WriteExecutor } from "../../../packages/agent-exec/write-operation.ts"
import {
  McpTextContent,
  McpToolResultContentItem,
  type McpResult,
} from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { emitMcpOutputSpillOutcome } from "../../../packages/agent/utils/mcp-metrics.ts"
import {
  materializeMcpTextOutput,
  writeToAgentToolsFile,
} from "./agent-tools-file-adapter.ts"

interface ResourceAccessor {
  get(resource: typeof writeExecutorResource): WriteExecutor
}

type SpillOutcome = "not_attempted" | "no_project_dir" | "write_failed" | "spilled"

export async function spillLargeMcpTextOutput({
  ctx,
  result,
  resourceAccessor,
  projectDir,
  osPlatform,
  toolCallId,
}: {
  readonly ctx: Context
  readonly result: McpResult
  readonly resourceAccessor: ResourceAccessor
  readonly projectDir: string | undefined
  readonly osPlatform: string | undefined
  readonly toolCallId: string
}): Promise<McpResult> {
  const originalItems = successfulContentOf(result)
  if (originalItems === undefined) return result

  let outcome: SpillOutcome = "not_attempted"
  const replacementItems = await materializeMcpTextOutput({
    contentItems: [...originalItems],
    thresholdBytes: MCP_TEXT_FILE_THRESHOLD_BYTES,
    write: async (text) => {
      if (projectDir === undefined) {
        outcome = "no_project_dir"
        return undefined
      }

      try {
        const location = await writeToAgentToolsFile(ctx, resourceAccessor.get(writeExecutorResource), {
          content: text,
          projectDir,
          osPlatform,
          toolCallId,
        })
        outcome = location === undefined ? "write_failed" : "spilled"
        return location
      } catch {
        outcome = "write_failed"
        return undefined
      }
    },
  })

  if (outcome === "not_attempted") return result
  if (outcome === "spilled" && replacementItems !== undefined) {
    emitMcpOutputSpillOutcome(ctx, "spilled")
    return withSuccessfulContent(result, replacementItems)
  }

  const failure = outcome === "no_project_dir" ? "no_project_dir" : "write_failed"
  emitMcpOutputSpillOutcome(ctx, failure)
  const text = inlineTextOf(originalItems)
  return withSuccessfulContent(
    result,
    replaceInlineText(originalItems, buildTruncatedMcpOutputText(text, MCP_TEXT_FILE_THRESHOLD_BYTES)),
  )
}

function successfulContentOf(result: McpResult): readonly McpToolResultContentItem[] | undefined {
  return result.result.case === "success" ? result.result.value.content : undefined
}

function inlineTextOf(items: readonly McpToolResultContentItem[]): string {
  return items
    .filter(isInlineText)
    .map(item => item.content.case === "text" ? item.content.value.text : "")
    .join("\n\n")
}

function replaceInlineText(
  items: readonly McpToolResultContentItem[],
  replacement: string,
): McpToolResultContentItem[] {
  const next: McpToolResultContentItem[] = []
  let inserted = false

  for (const item of items) {
    if (!isInlineText(item)) {
      next.push(item)
      continue
    }
    if (inserted) continue

    next.push(new McpToolResultContentItem({
      content: {
        case: "text",
        value: new McpTextContent({ text: replacement }),
      },
    }))
    inserted = true
  }

  return next
}

function isInlineText(item: McpToolResultContentItem): boolean {
  return item.content.case === "text" && item.content.value.outputLocation === undefined
}

function withSuccessfulContent(
  result: McpResult,
  content: McpToolResultContentItem[],
): McpResult {
  const copy = result.clone()
  if (copy.result.case === "success") copy.result.value.content = content
  return copy
}

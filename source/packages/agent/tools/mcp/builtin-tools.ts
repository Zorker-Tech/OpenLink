/**
 * The platform's own tools, offered to a model through the dynamic-tool route.
 *
 * A session with many tools pays for each one in its prompt, so the ones that are not always needed are
 * reached through discovery instead — and the platform's own tools are reached the same way as an MCP
 * server's, which means they need the same thing an MCP server does: a descriptor naming them, their
 * schemas, and instructions saying how to use them. Presenting them as a server rather than as a special
 * case is what keeps the model's route to them the same route it already knows.
 *
 * The registry is rebuilt whenever the tool set changes, and the descriptor is cached per set of meta
 * tool names, because the instructions name those tools and a session's names are only known once the
 * set is assembled. The concise context a tool carries is added to the instructions, since that is the
 * short version written for exactly this listing.
 *
 * A dispatch through the meta tool names a namespace and a tool; only the platform's own namespace is
 * answered here, and only for a tool the registry actually has — a name that is not one of ours is left
 * for whatever else may recognize it.
 */

import { Value } from "@bufbuild/protobuf"

import { DYNAMIC_TOOLS_NAMESPACE } from "../../../agent-exec/mcp-operations.ts"
import {
  McpImageContent,
  McpResult as McpToolResult,
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
} from "../../../proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpDescriptor, McpToolDescriptor } from "../../../proto/generated/agent/v1/mcp_pb.ts"
import { buildDescriptionGeneratorProps, getConciseStaticContext } from "../tool-execution.ts"

interface BuiltinTool {
  readonly name: string
  readonly toolIdentifier?: string | undefined
  readonly description?: string | undefined
  readonly descriptionGenerator?: (props: Record<string, unknown>, options: { promptVisible: boolean }) => string
  readonly contextType?: { readonly type?: string; readonly conciseStaticContext?: string } | undefined
  readonly parameters: { readonly jsonSchema?: unknown }
}

interface DynamicToolRegistryOptions {
  readonly directToolRecoveryEnabled?: boolean | undefined
}

/** A tool that writes its own description is asked for the one meant for a tool that is not shown. */
function resolveToolDescription(tool: BuiltinTool, props: Record<string, unknown>): string | undefined {
  if ("descriptionGenerator" in tool) return tool.descriptionGenerator!(props, { promptVisible: false })
  return tool.description
}

const BUILTIN_TOOLS_SERVER_USE_INSTRUCTIONS = "Native Slate tools for this session. These are highly recommended and useful tools that you should use when the right situation arises. Don't be afraid to look at one if it seems relevant, even if you don't end up using it. You MUST read the tool schemas before calling them."

function buildBuiltinToolsServerUseInstructions(tools: BuiltinTool[]): string {
  const lines = tools.flatMap(tool => {
    const text = getConciseStaticContext(tool.contextType)
    return text === undefined ? [] : [`- ${tool.name}: ${text}`]
  })
  if (lines.length === 0) return BUILTIN_TOOLS_SERVER_USE_INSTRUCTIONS
  return [BUILTIN_TOOLS_SERVER_USE_INSTRUCTIONS, "", "Here are some crucial instructions:", ...lines].join("\n")
}

export class DynamicToolRegistry {
  private readonly options: DynamicToolRegistryOptions
  private toolsByName = new Map<string, BuiltinTool>()
  private staticToolNames = new Set<string>()
  private descriptionProps: Record<string, unknown> = { allTools: {} }
  private cachedMcpDescriptors = new Map<string, McpDescriptor>()

  constructor(options: DynamicToolRegistryOptions = {}) {
    this.options = options
  }

  replaceTools({ dynamicTools, allTools }: { dynamicTools: BuiltinTool[]; allTools: BuiltinTool[] }): void {
    const nextToolsByName = new Map<string, BuiltinTool>()
    for (const tool of dynamicTools) nextToolsByName.set(tool.name, tool)
    let nextStaticToolNames = new Set<string>()
    // Only a session that can dispatch a tool directly needs to know which names are not dynamic.
    if (this.usesDirectToolRecovery()) {
      const dynamicToolSet = new Set(dynamicTools)
      nextStaticToolNames = new Set(allTools.filter(tool => !dynamicToolSet.has(tool)).map(tool => tool.name))
    }
    const nextDescriptionProps = buildDescriptionGeneratorProps(allTools as never)
    const descriptor = buildBuiltinToolsMcpDescriptorFromTools(
      [...nextToolsByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      nextDescriptionProps,
    )
    const nextCachedDescriptors = new Map<string, McpDescriptor>()
    if (descriptor !== undefined) nextCachedDescriptors.set("", descriptor)
    this.toolsByName = nextToolsByName
    this.staticToolNames = nextStaticToolNames
    this.descriptionProps = nextDescriptionProps
    this.cachedMcpDescriptors = nextCachedDescriptors
  }

  isEmpty(): boolean {
    return this.toolsByName.size === 0
  }

  getTool(name: string): BuiltinTool | undefined {
    return this.toolsByName.get(name)
  }

  isStaticTool(name: string): boolean {
    return this.staticToolNames.has(name)
  }

  usesDirectToolRecovery(): boolean {
    return this.options.directToolRecoveryEnabled === true
  }

  getTools(): BuiltinTool[] {
    return [...this.toolsByName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  getToolNames(): string[] {
    return this.getTools().map(tool => tool.name)
  }

  getDescriptionProps(): Record<string, unknown> {
    return this.descriptionProps
  }

  getMcpDescriptor(toolNames?: { discoveryToolName: string; invocationToolName: string }): McpDescriptor | undefined {
    const key = toolNames === undefined ? "" : `${toolNames.discoveryToolName}\0${toolNames.invocationToolName}`
    const cached = this.cachedMcpDescriptors.get(key)
    if (cached !== undefined) return cached
    const descriptor = buildBuiltinToolsMcpDescriptorFromTools(this.getTools(), this.descriptionProps)
    if (descriptor !== undefined) this.cachedMcpDescriptors.set(key, descriptor)
    return descriptor
  }
}

function buildBuiltinToolsMcpDescriptorFromTools(
  tools: BuiltinTool[],
  descriptionProps: Record<string, unknown>,
): McpDescriptor | undefined {
  if (tools.length === 0) return undefined
  const toolDescriptors = tools.map(tool => {
    const schema = tool.parameters.jsonSchema
    return new McpToolDescriptor({
      toolName: tool.name,
      description: resolveToolDescription(tool, descriptionProps) as string,
      ...(schema !== undefined ? { inputSchema: Value.fromJson(schema as never) } : {}),
    })
  })
  return new McpDescriptor({
    serverIdentifier: DYNAMIC_TOOLS_NAMESPACE,
    serverName: DYNAMIC_TOOLS_NAMESPACE,
    serverUseInstructions: buildBuiltinToolsServerUseInstructions(tools),
    tools: toolDescriptors,
  })
}

export function isReservedDynamicToolsNamespace(namespace: string): boolean {
  return namespace === DYNAMIC_TOOLS_NAMESPACE
}

/** A dispatch names a namespace and a tool; only our own namespace is answered, and only for a tool we have. */
export function resolveDynamicDispatchToolName(
  rawArgs: string,
  dynamicToolRegistry: Pick<DynamicToolRegistry, "getTool">,
): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const namespace = record["namespace"] ?? record["server"]
  if (typeof namespace !== "string" || !isReservedDynamicToolsNamespace(namespace)) return undefined
  const toolName = record["toolName"]
  if (typeof toolName !== "string") return undefined
  return dynamicToolRegistry.getTool(toolName)?.name
}

/** The platform's own tool result, in the shape an MCP caller reads. */
export function agentToolResultToMcpToolResult(rendered: {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}): McpToolResult {
  const content = rendered.content.map(item => {
    if (item.type === "text") {
      return new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: item.text! }) } })
    }
    if (item.type === "image") {
      return new McpToolResultContentItem({
        content: {
          case: "image",
          value: new McpImageContent({ data: Buffer.from(item.data!, "base64"), mimeType: item.mimeType ?? "image/png" }),
        },
      })
    }
    // Anything else is carried as its JSON, since MCP has no other way to say what it was.
    return new McpToolResultContentItem({
      content: { case: "text", value: new McpTextContent({ text: JSON.stringify(item) }) },
    })
  })
  return new McpToolResult({
    result: { case: "success", value: new McpSuccess({ content, isError: rendered.isError as boolean }) },
  })
}

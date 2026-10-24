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
 * A dispatch through the meta tool names a dispatchNamespace and a tool; only the platform's own dispatchNamespace is
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
  readonly descriptionGenerator?: (props: Record<string, unknown>, settings: { promptVisible: boolean }) => string
  readonly contextType?: { readonly type?: string; readonly conciseStaticContext?: string } | undefined
  readonly parameters: { readonly jsonSchema?: unknown }
}

interface RegistryOptions {
  readonly directToolRecoveryEnabled?: boolean | undefined
}

/** A tool that writes its own description is asked for the one meant for a tool that is not shown. */
function toolDescriptionFor(tool: BuiltinTool, props: Record<string, unknown>): string | undefined {
  if ("descriptionGenerator" in tool) return tool.descriptionGenerator!(props, { promptVisible: false })
  return tool.description
}

const SERVER_USE_PREAMBLE = "Native Slate tools for this session. These are highly recommended and useful tools that you should use when the right situation arises. Don't be afraid to look at one if it seems relevant, even if you don't end up using it. You MUST read the tool schemas before calling them."

function serverUseInstructionsFor(tools: BuiltinTool[]): string {
  const lines = tools.flatMap(tool => {
    const text = getConciseStaticContext(tool.contextType)
    return text === undefined ? [] : [`- ${tool.name}: ${text}`]
  })
  if (lines.length === 0) return SERVER_USE_PREAMBLE
  return [SERVER_USE_PREAMBLE, "", "Here are some crucial instructions:", ...lines].join("\n")
}

export class DynamicToolRegistry {
  private readonly settings: RegistryOptions
  private registry = new Map<string, BuiltinTool>()
  private nonDynamicNames = new Set<string>()
  private generatorProps: Record<string, unknown> = { allEntries: {} }
  private descriptorCache = new Map<string, McpDescriptor>()

  constructor(settings: RegistryOptions = {}) {
    this.settings = settings
  }

  replaceTools({ dynamicTools: dynamicEntries, allTools: allEntries }: { dynamicTools: BuiltinTool[]; allTools: BuiltinTool[] }): void {
    const nextRegistry = new Map<string, BuiltinTool>()
    for (const tool of dynamicEntries) nextRegistry.set(tool.name, tool)
    let nextNonDynamicNames = new Set<string>()
    // Only a session that can dispatch a tool directly needs to know which names are not dynamic.
    if (this.usesDirectToolRecovery()) {
      const dynamicEntrySet = new Set(dynamicEntries)
      nextNonDynamicNames = new Set(allEntries.filter(tool => !dynamicEntrySet.has(tool)).map(tool => tool.name))
    }
    const nextGeneratorProps = buildDescriptionGeneratorProps(allEntries as never)
    const descriptor = descriptorFromTools(
      [...nextRegistry.values()].sort((a, b) => a.name.localeCompare(b.name)),
      nextGeneratorProps,
    )
    const nextDescriptorCache = new Map<string, McpDescriptor>()
    if (descriptor !== undefined) nextDescriptorCache.set("", descriptor)
    this.registry = nextRegistry
    this.nonDynamicNames = nextNonDynamicNames
    this.generatorProps = nextGeneratorProps
    this.descriptorCache = nextDescriptorCache
  }

  isEmpty(): boolean {
    return this.registry.size === 0
  }

  getTool(name: string): BuiltinTool | undefined {
    return this.registry.get(name)
  }

  isStaticTool(name: string): boolean {
    return this.nonDynamicNames.has(name)
  }

  usesDirectToolRecovery(): boolean {
    return this.settings.directToolRecoveryEnabled === true
  }

  getTools(): BuiltinTool[] {
    return [...this.registry.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  getToolNames(): string[] {
    return this.getTools().map(tool => tool.name)
  }

  getDescriptionProps(): Record<string, unknown> {
    return this.generatorProps
  }

  getMcpDescriptor(toolNames?: { discoveryToolName: string; invocationToolName: string }): McpDescriptor | undefined {
    const key = toolNames === undefined ? "" : `${toolNames.discoveryToolName}\0${toolNames.invocationToolName}`
    const cached = this.descriptorCache.get(key)
    if (cached !== undefined) return cached
    const descriptor = descriptorFromTools(this.getTools(), this.generatorProps)
    if (descriptor !== undefined) this.descriptorCache.set(key, descriptor)
    return descriptor
  }
}

function descriptorFromTools(
  tools: BuiltinTool[],
  generatorProps: Record<string, unknown>,
): McpDescriptor | undefined {
  if (tools.length === 0) return undefined
  const descriptors = tools.map(tool => {
    const schema = tool.parameters.jsonSchema
    return new McpToolDescriptor({
      toolName: tool.name,
      description: toolDescriptionFor(tool, generatorProps) as string,
      ...(schema !== undefined ? { inputSchema: Value.fromJson(schema as never) } : {}),
    })
  })
  return new McpDescriptor({
    serverIdentifier: DYNAMIC_TOOLS_NAMESPACE,
    serverName: DYNAMIC_TOOLS_NAMESPACE,
    serverUseInstructions: serverUseInstructionsFor(tools),
    tools: descriptors,
  })
}

export function isReservedDynamicToolsNamespace(dispatchNamespace: string): boolean {
  return dispatchNamespace === DYNAMIC_TOOLS_NAMESPACE
}

/** A dispatch names a dispatchNamespace and a tool; only our own dispatchNamespace is answered, and only for a tool we have. */
export function resolveDynamicDispatchToolName(
  rawArguments: string,
  toolRegistry: Pick<DynamicToolRegistry, "getTool">,
): string | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  const dispatchNamespace = body["namespace"] ?? body["server"]
  if (typeof dispatchNamespace !== "string" || !isReservedDynamicToolsNamespace(dispatchNamespace)) return undefined
  const requestedToolName = body["toolName"]
  if (typeof requestedToolName !== "string") return undefined
  return toolRegistry.getTool(requestedToolName)?.name
}

/** The platform's own tool result, in the shape an MCP caller reads. */
export function agentToolResultToMcpToolResult(toolResult: {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}): McpToolResult {
  const contentItems = toolResult.content.map(entry => {
    if (entry.type === "text") {
      return new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: entry.text! }) } })
    }
    if (entry.type === "image") {
      return new McpToolResultContentItem({
        content: {
          case: "image",
          value: new McpImageContent({ data: Buffer.from(entry.data!, "base64"), mimeType: entry.mimeType ?? "image/png" }),
        },
      })
    }
    // Anything else is carried as its JSON, since MCP has no other way to say what it was.
    return new McpToolResultContentItem({
      content: { case: "text", value: new McpTextContent({ text: JSON.stringify(entry) }) },
    })
  })
  return new McpToolResult({
    result: { case: "success", value: new McpSuccess({ content: contentItems, isError: toolResult.isError as boolean }) },
  })
}

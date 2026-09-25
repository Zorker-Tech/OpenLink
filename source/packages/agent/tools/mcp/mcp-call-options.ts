/**
 * What an MCP call needs to be understood before it is made.
 *
 * Two things have to be settled before a call to a server's tool can run. The first is which servers and
 * which tools exist at all: that comes from the session's descriptors, and it is filtered here — a session
 * that cannot ask the user to sign in has no business offering the sign-in tool, so that tool is removed
 * and the descriptor it belonged to is rebuilt without it. The second is the shape of the arguments, which
 * is where models go wrong in ways that are worth surviving rather than refusing: a call may name the
 * server `namespace`, may put the description in a side field, may send `arguments` as a quoted string
 * that is really JSON, or may put the approval fields inside `arguments` where they do not belong. All of
 * those are read back into the one shape the call path expects, because the alternative is a failed call
 * the user has to retry by hand.
 *
 * Two schemas are therefore kept for the same call. The one the model sees declares what it should send;
 * the one used for parsing accepts what it actually sent, normalizes it, and then validates the result.
 */

import { z } from "zod"

import { McpDescriptor, type McpFileSystemOptions, type McpMetaToolOptions } from "../../../proto/generated/agent/v1/mcp_pb.ts"
import { parseArgumentsLeniently } from "./argument-repair.ts"

/** The tool a client offers for signing in to a server, which only an interactive session may call. */
export const MCP_AUTH_VIRTUAL_TOOL_NAME = "mcp_auth"

export interface McpDescriptorIndex {
  readonly serverDescriptors: ReadonlyMap<string, McpDescriptor>
  readonly toolDefinitionPaths: ReadonlyMap<string, string>
}

/** The servers and tools this session can call, keyed by the server's own identifier. */
export function indexMcpDescriptors({
  mcpMetaToolEnabled,
  mcpMetaToolOptions,
  mcpFileSystemOptions,
  allowInteractiveMcpAuth = false,
}: {
  readonly mcpMetaToolEnabled: boolean
  readonly mcpMetaToolOptions?: McpMetaToolOptions | undefined
  readonly mcpFileSystemOptions?: McpFileSystemOptions | undefined
  readonly allowInteractiveMcpAuth?: boolean | undefined
}): McpDescriptorIndex {
  const serverDescriptors = new Map<string, McpDescriptor>()
  const toolDefinitionPaths = new Map<string, string>()
  // The meta tool carries its own descriptor list; without it the session's filesystem options do.
  const descriptorSource = mcpMetaToolEnabled
    ? mcpMetaToolOptions?.mcpDescriptors ?? []
    : mcpFileSystemOptions?.mcpDescriptors ?? []

  for (const descriptor of descriptorSource) {
    const rawTools = descriptor.tools
    const descriptorTools = allowInteractiveMcpAuth
      ? rawTools
      : rawTools.filter(tool => tool.toolName !== MCP_AUTH_VIRTUAL_TOOL_NAME)
    // A descriptor whose tools all survive is registered as it came; one that lost a tool is rebuilt
    // from the fields a descriptor is allowed to carry, so the removed tool cannot leak back in.
    const descriptorForRegistration = allowInteractiveMcpAuth || descriptorTools.length === rawTools.length
      ? descriptor
      : new McpDescriptor({
        serverIdentifier: descriptor.serverIdentifier,
        serverName: descriptor.serverName,
        ...(descriptor.plugin !== undefined ? { plugin: descriptor.plugin } : {}),
        ...(descriptor.marketplace !== undefined ? { marketplace: descriptor.marketplace } : {}),
        ...(descriptor.serverUseInstructions !== undefined ? { serverUseInstructions: descriptor.serverUseInstructions } : {}),
        ...(descriptor.folderPath !== undefined ? { folderPath: descriptor.folderPath } : {}),
        ...(descriptor.pluginDbId !== undefined ? { pluginDbId: descriptor.pluginDbId } : {}),
        ...(descriptor.marketplaceId !== undefined ? { marketplaceId: descriptor.marketplaceId } : {}),
        tools: descriptorTools,
      })
    serverDescriptors.set(descriptor.serverIdentifier, descriptorForRegistration)
    for (const tool of descriptorTools) {
      if (tool.definitionPath !== undefined) {
        toolDefinitionPaths.set(`${descriptor.serverIdentifier}:${tool.toolName}`, tool.definitionPath)
      }
    }
  }

  return { serverDescriptors, toolDefinitionPaths }
}

export interface McpCallSchemas {
  readonly parametersSchema: z.ZodType<unknown>
  readonly parsingParametersSchema: z.ZodType<unknown>
  readonly normalizeInput: (raw: unknown) => unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Tool arguments are whatever the server's descriptor says, so any JSON value may appear. */
function buildJsonValueSchema(): z.ZodType<unknown> {
  let jsonValueSchema: z.ZodType<unknown>
  jsonValueSchema = z.lazy(() => z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.record(jsonValueSchema),
    z.array(jsonValueSchema),
  ]))
  return jsonValueSchema
}

export function buildMcpCallSchemas({
  useDynamicToolNamespaces,
  smartModeClassifierMode,
}: {
  readonly useDynamicToolNamespaces: boolean
  readonly smartModeClassifierMode: boolean
}): McpCallSchemas {
  const jsonValueSchema = buildJsonValueSchema()
  const argumentsRecordSchema = z.record(jsonValueSchema)
  const argumentsParameterSchema = argumentsRecordSchema
    .optional()
    .describe(useDynamicToolNamespaces
      ? "Arguments to pass to the tool, as described by the tool descriptor."
      : "Arguments to pass to the MCP tool, as described in the tool descriptor.")
  const baseParametersSchema = z.object({
    server: z.string().describe("Identifier of the MCP server hosting the tool."),
    toolName: z.string().describe("Name of the MCP tool to invoke."),
    arguments: argumentsParameterSchema,
  })
  const modelIdentityParametersSchema = useDynamicToolNamespaces
    ? z.object({
      namespace: z.string().describe("Dynamic namespace hosting the tool, e.g. an MCP server."),
      toolName: z.string().describe("Name of the tool to invoke."),
    })
    : baseParametersSchema.omit({ arguments: true })
  const callDescriptionSchema = z.string().describe("Short plain-language description of what this call will do. One sentence naming the outcome and where it applies (channel, page, file, or service) when known. Do not include tool names, argument keys, or JSON.")
  const descriptionParametersSchema = z.object({ description: callDescriptionSchema.optional() })
  const smartModeApprovalParametersSchema = z.object({
    requestSmartModeApproval: z.boolean().optional().describe("Set to true when immediately retrying the exact same MCP call after Auto-review blocks it and you decide the user should approve it through the native approval card."),
    smartModeBlockReason: z.string().optional().describe("Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier."),
  })
  const mcpDetailsParametersSchema = z.object({
    description: callDescriptionSchema,
    ...(smartModeClassifierMode
      ? {
        requestSmartModeApproval: smartModeApprovalParametersSchema.shape.requestSmartModeApproval.default(false),
        smartModeBlockReason: smartModeApprovalParametersSchema.shape.smartModeBlockReason,
      }
      : {}),
  })
  const mcpDetailsInputSchema = z.object({
    description: callDescriptionSchema.optional(),
    ...smartModeApprovalParametersSchema.shape,
  })
  // A dynamic namespace carries the call's metadata in a side object; a first-party call carries it flat.
  const parametersSchema = useDynamicToolNamespaces
    ? modelIdentityParametersSchema.extend({
      mcpDetails: mcpDetailsParametersSchema.optional().describe("MCP-specific call metadata. Set this only when invoking a tool from an external MCP namespace; omit it for first-party tools in the cursor namespace."),
      arguments: argumentsParameterSchema,
    })
    : modelIdentityParametersSchema.extend({
      ...descriptionParametersSchema.shape,
      ...(smartModeClassifierMode ? smartModeApprovalParametersSchema.shape : {}),
      arguments: argumentsParameterSchema,
    })

  const normalizeInput = (raw: unknown): unknown => {
    if (!isRecord(raw)) return raw
    const normalized = { ...raw }
    if (useDynamicToolNamespaces) {
      if (normalized.namespace !== undefined) {
        normalized.server = normalized.namespace
        delete normalized.namespace
      }
      // A call that names no tool is refused rather than guessed at from its arguments.
      const missingIdentity = [
        normalized.server === undefined ? "namespace" : undefined,
        normalized.toolName === undefined ? "toolName" : undefined,
      ].filter((field): field is string => field !== undefined)
      if (missingIdentity.length > 0) {
        throw new Error(`Missing required ${missingIdentity.length === 1 ? "field" : "fields"}: ${missingIdentity.join(", ")}. Re-issue the call with the tool's identity set; \`arguments\` alone does not identify the tool.`)
      }
    }
    if (normalized.descriptionForMcp !== undefined) {
      normalized.description ??= normalized.descriptionForMcp
      delete normalized.descriptionForMcp
    }
    if (typeof normalized.arguments === "string") {
      const recovered = parseArgumentsLeniently(normalized.arguments)
      if (recovered === undefined) {
        throw new Error("Failed to parse arguments string as JSON object. Re-issue the call with `arguments` as a JSON object literal rather than a quoted string.")
      }
      const args = recovered.args
      // When the string had to be repaired, the call's own metadata may have been folded into it.
      if (recovered.repaired) {
        const foldedDetails = args.mcpDetails
        if (foldedDetails !== undefined) {
          delete args.mcpDetails
          normalized.mcpDetails ??= foldedDetails
        }
        const foldedDescription = args.descriptionForMcp
        if (foldedDescription !== undefined) {
          delete args.descriptionForMcp
          normalized.description ??= foldedDescription
        }
      }
      const leakedDescription = recovered.envelopeFields?.description
      if (leakedDescription !== undefined && normalized.description === undefined) {
        normalized.description = leakedDescription
      }
      normalized.arguments = args
    }
    // The approval fields describe the call, not the tool: they are lifted out of the arguments so the
    // server never receives them and the approval path can read them.
    if (smartModeClassifierMode && isRecord(normalized.arguments)) {
      if ("requestSmartModeApproval" in normalized.arguments || "smartModeBlockReason" in normalized.arguments) {
        const stripped = { ...normalized.arguments }
        normalized.requestSmartModeApproval ??= stripped.requestSmartModeApproval
        normalized.smartModeBlockReason ??= stripped.smartModeBlockReason
        delete stripped.requestSmartModeApproval
        delete stripped.smartModeBlockReason
        normalized.arguments = stripped
      }
    }
    return normalized
  }

  const internalParametersSchema = useDynamicToolNamespaces
    ? baseParametersSchema.extend({
      ...descriptionParametersSchema.shape,
      ...smartModeApprovalParametersSchema.shape,
      mcpDetails: mcpDetailsInputSchema.optional(),
    }).transform(({ mcpDetails, ...args }) => ({
      ...args,
      description: mcpDetails?.description ?? args.description,
      requestSmartModeApproval: mcpDetails?.requestSmartModeApproval ?? args.requestSmartModeApproval,
      smartModeBlockReason: mcpDetails?.smartModeBlockReason ?? args.smartModeBlockReason,
    }))
    : baseParametersSchema.extend({
      ...descriptionParametersSchema.shape,
      ...(smartModeClassifierMode ? smartModeApprovalParametersSchema.shape : {}),
    })

  return {
    parametersSchema,
    parsingParametersSchema: z.preprocess(normalizeInput, internalParametersSchema),
    normalizeInput,
  }
}

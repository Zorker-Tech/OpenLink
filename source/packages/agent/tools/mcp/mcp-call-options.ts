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
  allowInteractiveMcpAuth: allowInteractiveAuth = false,
}: {
  readonly mcpMetaToolEnabled: boolean
  readonly mcpMetaToolOptions?: McpMetaToolOptions | undefined
  readonly mcpFileSystemOptions?: McpFileSystemOptions | undefined
  readonly allowInteractiveMcpAuth?: boolean | undefined
}): McpDescriptorIndex {
  const serverDescriptors = new Map<string, McpDescriptor>()
  const toolDefinitionPaths = new Map<string, string>()
  // The meta tool carries its own descriptor list; without it the session's filesystem options do.
  const descriptorList = mcpMetaToolEnabled
    ? mcpMetaToolOptions?.mcpDescriptors ?? []
    : mcpFileSystemOptions?.mcpDescriptors ?? []

  for (const descriptor of descriptorList) {
    const originalTools = descriptor.tools
    const keptTools = allowInteractiveAuth
      ? originalTools
      : originalTools.filter(tool => tool.toolName !== MCP_AUTH_VIRTUAL_TOOL_NAME)
    // A descriptor whose tools all survive is registered as it came; one that lost a tool is rebuilt
    // from the fields a descriptor is allowed to carry, so the removed tool cannot leak back in.
    const descriptorToRegister = allowInteractiveAuth || keptTools.length === originalTools.length
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
        tools: keptTools,
      })
    serverDescriptors.set(descriptor.serverIdentifier, descriptorToRegister)
    for (const tool of keptTools) {
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
  readonly normalizeInput: (rawInput: unknown) => unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Tool arguments are whatever the server's descriptor says, so any JSON value may appear. */
function buildJsonValueSchema(): z.ZodType<unknown> {
  let jsonValue: z.ZodType<unknown>
  jsonValue = z.lazy(() => z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.record(jsonValue),
    z.array(jsonValue),
  ]))
  return jsonValue
}

export function buildMcpCallSchemas({
  useDynamicToolNamespaces,
  smartModeClassifierMode,
}: {
  readonly useDynamicToolNamespaces: boolean
  readonly smartModeClassifierMode: boolean
}): McpCallSchemas {
  const jsonValue = buildJsonValueSchema()
  const argumentsRecord = z.record(jsonValue)
  const argumentsParameter = argumentsRecord
    .optional()
    .describe(useDynamicToolNamespaces
      ? "Arguments to pass to the tool, as described by the tool descriptor."
      : "Arguments to pass to the MCP tool, as described in the tool descriptor.")
  const baseParameters = z.object({
    server: z.string().describe("Identifier of the MCP server hosting the tool."),
    toolName: z.string().describe("Name of the MCP tool to invoke."),
    arguments: argumentsParameter,
  })
  const identityParameters = useDynamicToolNamespaces
    ? z.object({
      namespace: z.string().describe("Dynamic namespace hosting the tool, e.g. an MCP server."),
      toolName: z.string().describe("Name of the tool to invoke."),
    })
    : baseParameters.omit({ arguments: true })
  const callDescription = z.string().describe("Short plain-language description of what this call will do. One sentence naming the outcome and where it applies (channel, page, file, or service) when known. Do not include tool names, argument keys, or JSON.")
  const descriptionParameters = z.object({ description: callDescription.optional() })
  const approvalParameters = z.object({
    requestSmartModeApproval: z.boolean().optional().describe("Set to true when immediately retrying the exact same MCP call after Auto-review blocks it and you decide the user should approve it through the native approval card."),
    smartModeBlockReason: z.string().optional().describe("Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier."),
  })
  const detailsParameters = z.object({
    description: callDescription,
    ...(smartModeClassifierMode
      ? {
        requestSmartModeApproval: approvalParameters.shape.requestSmartModeApproval.default(false),
        smartModeBlockReason: approvalParameters.shape.smartModeBlockReason,
      }
      : {}),
  })
  const detailsInput = z.object({
    description: callDescription.optional(),
    ...approvalParameters.shape,
  })
  // A dynamic namespace carries the call's metadata in a side object; a first-party call carries it flat.
  const parametersSchema = useDynamicToolNamespaces
    ? identityParameters.extend({
      mcpDetails: detailsParameters.optional().describe("MCP-specific call metadata. Set this only when invoking a tool from an external MCP namespace; omit it for first-party tools in the slate namespace."),
      arguments: argumentsParameter,
    })
    : identityParameters.extend({
      ...descriptionParameters.shape,
      ...(smartModeClassifierMode ? approvalParameters.shape : {}),
      arguments: argumentsParameter,
    })

  const normalizeInput = (rawInput: unknown): unknown => {
    if (!isRecord(rawInput)) return rawInput
    const normalizedCall = { ...rawInput }
    if (useDynamicToolNamespaces) {
      if (normalizedCall.namespace !== undefined) {
        normalizedCall.server = normalizedCall.namespace
        delete normalizedCall.namespace
      }
      // A call that names no tool is refused rather than guessed at from its arguments.
      const missingIdentity = [
        normalizedCall.server === undefined ? "namespace" : undefined,
        normalizedCall.toolName === undefined ? "toolName" : undefined,
      ].filter((field): field is string => field !== undefined)
      if (missingIdentity.length > 0) {
        throw new Error(`Missing required ${missingIdentity.length === 1 ? "field" : "fields"}: ${missingIdentity.join(", ")}. Re-issue the call with the tool's identity set; \`arguments\` alone does not identify the tool.`)
      }
    }
    if (normalizedCall.descriptionForMcp !== undefined) {
      normalizedCall.description ??= normalizedCall.descriptionForMcp
      delete normalizedCall.descriptionForMcp
    }
    if (typeof normalizedCall.arguments === "string") {
      const recoveredArguments = parseArgumentsLeniently(normalizedCall.arguments)
      if (recoveredArguments === undefined) {
        throw new Error("Failed to parse arguments string as JSON object. Re-issue the call with `arguments` as a JSON object literal rather than a quoted string.")
      }
      const argumentObject = recoveredArguments.args
      // When the string had to be repaired, the call's own metadata may have been folded into it.
      if (recoveredArguments.repaired) {
        const foldedMeta = argumentObject.mcpDetails
        if (foldedMeta !== undefined) {
          delete argumentObject.mcpDetails
          normalizedCall.mcpDetails ??= foldedMeta
        }
        const foldedDescriptionText = argumentObject.descriptionForMcp
        if (foldedDescriptionText !== undefined) {
          delete argumentObject.descriptionForMcp
          normalizedCall.description ??= foldedDescriptionText
        }
      }
      const leakedDescriptionText = recoveredArguments.envelopeFields?.description
      if (leakedDescriptionText !== undefined && normalizedCall.description === undefined) {
        normalizedCall.description = leakedDescriptionText
      }
      normalizedCall.arguments = argumentObject
    }
    // The approval fields describe the call, not the tool: they are lifted out of the arguments so the
    // server never receives them and the approval path can read them.
    if (smartModeClassifierMode && isRecord(normalizedCall.arguments)) {
      if ("requestSmartModeApproval" in normalizedCall.arguments || "smartModeBlockReason" in normalizedCall.arguments) {
        const argumentsWithoutApproval = { ...normalizedCall.arguments }
        normalizedCall.requestSmartModeApproval ??= argumentsWithoutApproval.requestSmartModeApproval
        normalizedCall.smartModeBlockReason ??= argumentsWithoutApproval.smartModeBlockReason
        delete argumentsWithoutApproval.requestSmartModeApproval
        delete argumentsWithoutApproval.smartModeBlockReason
        normalizedCall.arguments = argumentsWithoutApproval
      }
    }
    return normalizedCall
  }

  const parsedParameters = useDynamicToolNamespaces
    ? baseParameters.extend({
      ...descriptionParameters.shape,
      ...approvalParameters.shape,
      mcpDetails: detailsInput.optional(),
    }).transform(({ mcpDetails, ...argumentObject }) => ({
      ...argumentObject,
      description: mcpDetails?.description ?? argumentObject.description,
      requestSmartModeApproval: mcpDetails?.requestSmartModeApproval ?? argumentObject.requestSmartModeApproval,
      smartModeBlockReason: mcpDetails?.smartModeBlockReason ?? argumentObject.smartModeBlockReason,
    }))
    : baseParameters.extend({
      ...descriptionParameters.shape,
      ...(smartModeClassifierMode ? approvalParameters.shape : {}),
    })

  return {
    parametersSchema,
    parsingParametersSchema: z.preprocess(normalizeInput, parsedParameters),
    normalizeInput,
  }
}

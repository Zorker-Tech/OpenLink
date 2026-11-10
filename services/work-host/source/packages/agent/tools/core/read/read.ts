/**
 * The tool that reads a file.
 *
 * A read is a request to another process — the workspace is not this process's — so the tool's job is to
 * ask for the file, then turn whatever comes back into something the model can use. Three kinds of answer
 * exist and each is rendered differently: text, which is written out with the line numbers and the range
 * that was read; an image, which is sent as bytes with the file's own mime type; and a notebook, which is
 * written out as cells rather than as JSON. A PDF is neither — it is extracted to text first, and the
 * extraction is cached per path because the same PDF is often read twice in one turn.
 *
 * Large content is not carried in the conversation at all: past a threshold it is stored as a blob and the
 * result refers to it, which is what keeps a big file from consuming the turn's context. The result is
 * hydrated again at render time, where the blob store is available.
 *
 * The tool is also where a read is accounted for: the path is recorded on the conversation, the rules and
 * skills that belong to the file are attached to the result so the model sees them next to what it read,
 * and a read of a skill file is recorded as the skill being used. What the arguments are called and how
 * the tool describes itself depends on the prompt version, because the model reading it is the one that
 * has to recognize it.
 */

import { z } from "zod"

import type { Context } from "../../../../context/context.ts"
import { createSpan } from "../../../../context/telemetry.ts"
import type { BlobStore } from "../../../../agent-kv/blob-store.ts"
import { getBlobId } from "../../../../agent-kv/blob-store.ts"
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../../agent-exec/executor-resources.ts"
import { resolveReadPromptProfile, type ReadPromptProfile } from "../../../../../adapters/interop/agent/read-tool-prompt-adapter.ts"
import {
  createReadConversationPort,
  createReadExecutorPort,
  fromInteropReadRules,
  fromInteropReadToolResult,
  toInteropReadToolCall,
  toInteropReadToolErrorCall,
  toInteropReadToolResult,
} from "../../../../../adapters/interop/agent/read-tool-protocol-adapter.ts"
import type {
  ReadConversationPort,
  ReadExecutionResultModel,
  ReadFormattingOptions,
  ReadRangeModel,
  ReadRuleModel,
  ReadToolCallModel,
  ReadToolResultModel,
} from "./read-contract.ts"
import { createReadRenderer, type ReadRenderProps } from "./read-renderer.ts"
import type { HookContextEntry } from "../../../../hooks-carriers/hook-additional-context.ts"
import { ToolCallError, createZodAgentTool, generateSeededUuid, withSafeParsedArgs } from "../../tool-support.ts"
import { ToolCallRejectedError, ToolCallUnexpectedEnvironmentError } from "../../tool-errors.ts"
import { READ_OUTPUT_BOUNDS } from "../../read-limits.ts"
import { isPdfBinary } from "./pdf-utils.ts"
import { adaptLegacyWorktreePath } from "../../../../../adapters/interop/workspace/legacy-worktree-path-adapter.ts"
import { getConversationId } from "../../../utils/request-scope.ts"
import { isAgentTranscriptPath } from "../../../../utils/managed-paths.ts"
import { classifyInteropSkillSourcePath } from "../../../../../adapters/interop/agent/skill-source-path-adapter.ts"
import { getAgentEventTracker, recordSkillApplied } from "../../../utils/event-tracking.ts"
import { trackMcpDirectoryAccessIfApplicable, trackMcpDirectoryResponseBytes } from "../../../utils/mcp-metrics.ts"
import { filterItemsForRunEnvironment } from "../../../utils/environment-filtering.ts"
import type { AgentType } from "../../../utils/agent-config.ts"
import { getSkillIdFromPath } from "../../../skill-id.ts"
import { createCounter, createHistogram } from "../../../../metrics/index.ts"
import { safeString } from "../../../../redaction/create.ts"
import type { RedactedString } from "../../../../redaction/redacted-values.ts"

export type { ReadFormattingOptions } from "./read-contract.ts"

export type ReadResourceAccessor = ResourceAccessor<RemoteExecManager>
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<string>

export interface ReadToolOptions {
  readonly toolName?: string
  readonly toolIdentifier?: string
  readonly toolDescription?: string
  readonly preferRedactedRead?: boolean
  readonly enableLineNumbersArg?: boolean
  readonly enableNegativeOffset?: boolean
  readonly useMinimalHarness?: boolean
  readonly useExplicitOffsetLimitDescription?: boolean
  readonly pdfTextExtractor?: PdfTextExtractor
}

interface ReadStateHandler {
  readonly getBlobStore?: () => BlobStore<Context> | undefined
  readonly readPaths?: ReadonlySet<string>
  readonly recordReadPath?: (path: string) => void
  readonly agentType?: AgentType
  readonly lastSkillCatalogBudgetStrategy?: string
  readonly isLargeContextModel?: () => boolean
}

interface ReadSkill {
  readonly fullPath?: string
  readonly description?: string
  readonly disableModelInvocation?: boolean
  readonly parseError?: string
  readonly environment?: string
  readonly plugin?: string
  readonly marketplace?: string
  readonly pluginId?: string
  readonly marketplaceId?: string
  readonly disabledEnvironments?: readonly string[]
  readonly environments?: readonly string[]
}

interface ReadMetadata {
  readonly [key: string]: unknown
  readonly toolCallId: string
  readonly stateHandler?: ReadStateHandler
  readonly hookContextCollector?: HookContextEntry[]
  readonly stepReadPathDedup?: Set<string>
  readonly rules?: readonly unknown[]
  readonly agentSkills?: readonly ReadSkill[]
  readonly workspacePaths?: readonly string[]
}

interface ReadArgsLike {
  readonly path?: string
  readonly target_file?: string
  readonly offset?: number
  readonly limit?: number
  readonly line_range?: readonly [number, number]
  readonly include_line_numbers?: boolean
}

/** Formats that are never text, so reading them as text would only produce noise. */
const UNSUPPORTED_BINARY_EXTENSIONS = /\.(zip|tar|gz|exe|dll|so|dylib|bin|mp4|webm|mov|avi|mkv|wmv|flv|m4v)$/i
const MAX_CONVERSATION_ID_LENGTH = 200

/** A PDF is extracted once per path, since the same document is often read twice in one turn. */
const pdfTextCache = new Map<string, string>()
/** The skills that belong to a result, kept beside it rather than recomputed when it is rendered. */
const readErrorsDistribution = createHistogram("agent.tools.read.errors", {
  description: "Number of errors per read operation",
  labelNames: [],
})
const readTotalCounter = createCounter("agent.tools.read.total", {
  description: "Total file read operations",
  labelNames: [],
})

function getSafeConversationId(conversationId: string): string {
  let safe = encodeURIComponent(conversationId).replace(/%/g, "_")
  if (safe.length > MAX_CONVERSATION_ID_LENGTH) safe = safe.slice(0, MAX_CONVERSATION_ID_LENGTH)
  return safe
}

function lastPathComponent(filePath: string): string {
  const parts = filePath.split(/[/\\]+/).filter(Boolean)
  return parts[parts.length - 1] ?? filePath
}

function stripKnownTranscriptExtension(fileName: string): string {
  if (fileName.endsWith(".txt")) return fileName.slice(0, -4)
  if (fileName.endsWith(".json")) return fileName.slice(0, -5)
  return fileName
}

function normalizeComparablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/, "")
}

function matchingSkill(filePath: string, skills: readonly ReadSkill[] | undefined): ReadSkill | undefined {
  const normalized = normalizeComparablePath(filePath)
  return skills?.find(skill => skill.fullPath !== undefined && normalizeComparablePath(skill.fullPath) === normalized)
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** The lines a request asked for: an offset counts from the start, or from the end when it is negative. */
function computeReadSlice(totalLines: number, offset: number | undefined, limit: number | undefined): {
  readonly startIndex: number
  readonly endIndex: number
  readonly readRange: ReadRangeModel
} | undefined {
  if (offset === undefined && limit === undefined) return undefined
  const effectiveOffset = offset ?? 1
  const effectiveLimit = limit ?? (effectiveOffset < 0 ? Math.abs(effectiveOffset) : totalLines)
  const startIndex = effectiveOffset < 0 ? Math.max(0, totalLines + effectiveOffset) : Math.max(0, effectiveOffset - 1)
  const endIndex = Math.min(totalLines, startIndex + effectiveLimit)
  if (startIndex >= totalLines) {
    throw new ToolCallUnexpectedEnvironmentError(`Offset ${offset} is beyond file length (${totalLines} lines)`)
  }
  return { startIndex, endIndex, readRange: { startLine: startIndex + 1, endLine: endIndex } }
}

function createSuccessResult(
  content: string,
  totalLines: number,
  fileSize: number,
  filePath: string,
  readRange: ReadRangeModel | undefined,
  includeLineNumbers: boolean | undefined,
): ReadToolResultModel {
  const exceededLimit = content.length > READ_OUTPUT_BOUNDS.maximumCharacters
  return {
    result: {
      case: "success",
      value: {
        // Content over the hard limit is withheld rather than truncated: the caller is told to read a range.
        output: { case: "content", value: exceededLimit ? "" : content },
        isEmpty: !exceededLimit && totalLines === 0 && content === "",
        exceededLimit,
        totalLines,
        fileSize,
        path: filePath,
        ...(readRange === undefined ? {} : { readRange }),
        ...(includeLineNumbers === undefined ? {} : { includeLineNumbers }),
      },
    },
  }
}

function positiveIntegerSchema(description: string, allowNegative = false): z.ZodType<number | undefined> {
  return z.number().int().optional()
    .refine(
      value => value === undefined || value === 0 || value >= 1 || (allowNegative && value <= -1),
      allowNegative ? "Offset must be >= 1 or <= -1." : "Offset must be >= 1.",
    )
    .transform(value => (value === 0 ? 1 : value))
    .describe(description)
}

function limitSchema(): z.ZodType<number | undefined> {
  return z.number().int().optional()
    .refine(value => value === undefined || value >= 1, "Limit must be >= 1.")
    .describe("The number of lines to read. Only provide if the file is too large to read at once.")
}

function lineNumbersSchema(sparse: boolean): z.ZodType<boolean | undefined> {
  const suffix = sparse ? "" : " Lines are numbered starting at 1, using the format LINE_NUMBER|LINE_CONTENT."
  return z.boolean().optional().describe(`Whether to include line numbers in the output.${suffix} Prefer using this only when needed, e.g. for citing codeblocks to the user. Defaults to false.`)
}

/** The arguments a version's model was trained to send, including what the file is called. */
function parametersSchema(profile: ReadPromptProfile, includeLineNumbers: boolean, sparse: boolean): z.ZodTypeAny {
  const lineNumberField = includeLineNumbers ? { include_line_numbers: lineNumbersSchema(sparse) } : {}
  const pathField = profile.argumentStyle === "workspace-target"
    ? { target_file: z.string().describe("Path of the file to inspect, relative to the workspace or absolute.") }
    : { path: z.string().describe("Path of the file to inspect.") }
  if (profile.argumentStyle === "path-only") return z.object(pathField)
  if (profile.argumentStyle === "path-range") {
    return z.object({
      ...pathField,
      line_range: z.array(z.number().int()).min(2).max(2).optional(),
      ...lineNumberField,
    })
  }
  return z.object({
    ...pathField,
    offset: positiveIntegerSchema("First line to return. Omit to start at the beginning.", profile.allowNegativeOffset),
    limit: limitSchema(),
    ...lineNumberField,
  })
}

function toolDescription(
  profile: ReadPromptProfile,
  explicitOffsetLimit: boolean,
  includeLineNumbers: boolean,
  sparse: boolean,
): string {
  if (profile.descriptionStyle === "image-only") return "Preview an image from a local path. Use the shell tool for other file content."
  if (profile.descriptionStyle === "compact-image") return "Read a local file. JPEG, PNG, GIF and WebP images can also be viewed."
  const usage = explicitOffsetLimit
    ? "- Leave offset and limit out to return the whole file.\n- Set both to read a particular range in a long file."
    : "- For long files, set offset and limit to inspect one portion. Otherwise, omit them for the complete file."
  const numbers = includeLineNumbers && !sparse
    ? "\n- Returned lines use one-based labels in the form LINE_NUMBER|LINE_CONTENT."
    : ""
  const base = `Read the file at the supplied path. A missing file is reported as an error, and an empty file is identified explicitly.\n\n${usage}${numbers}\n- Multiple independent file reads may be requested together when useful.`
  const withImages = `${base}\n\nImage files are returned for visual inspection when supported (JPEG, PNG, GIF and WebP).`
  return profile.descriptionStyle === "full"
    ? `${withImages}\n\nPDF files are converted to text and follow the same output-size limit as other files.`
    : profile.descriptionStyle === "image"
      ? withImages
      : base
}

/** What the model is told about the rules that belong to the file it just read. */
function isMcpReadPath(filePath: string): boolean {
  return filePath.includes("/mcps/")
}

export function createReadTool(
  resourceAccessor: ReadResourceAccessor,
  formattingOptions: ReadFormattingOptions,
  promptVersion = "latest",
  options: ReadToolOptions = {},
): Record<string, unknown> {
  const readExecutor = createReadExecutorPort(resourceAccessor, options.preferRedactedRead === true)
  const minimal = options.useMinimalHarness === true
  const includeLineNumbersArg = options.enableLineNumbersArg === true
  const sparse = formattingOptions.useSparseReadLineNumbers === true
  const renderer = createReadRenderer(formattingOptions, sparse)
  const profile = resolveReadPromptProfile(promptVersion, {
    imageOnly: minimal,
    allowNegativeOffset: options.enableNegativeOffset === true,
  })
  const schema = parametersSchema(profile, includeLineNumbersArg, sparse)
  const name = options.toolName ?? profile.toolName
  const description = options.toolDescription ??
    toolDescription(profile, options.useExplicitOffsetLimitDescription === true, !includeLineNumbersArg, sparse)

  const execute = async (
    parentContext: Context,
    interactionHandler: ReadConversationPort,
    rawArgs: ReadArgsLike,
    meta: ReadMetadata,
  ): Promise<ReadToolResultModel> => {
    using span = createSpan(parentContext.withName("readExecute"))
    const originalPath = "target_file" in rawArgs ? rawArgs.target_file : rawArgs.path
    if (typeof originalPath !== "string") throw new ToolCallUnexpectedEnvironmentError("Read path is missing")
    const filePath = adaptLegacyWorktreePath(originalPath)
    trackMcpDirectoryAccessIfApplicable(span.ctx, filePath, "read")
    if (isAgentTranscriptPath(filePath)) {
      // Reading one's own transcript is legitimate; the access is only worth noting for diagnostics.
      const conversationId = getConversationId(span.ctx)
      const leaf = stripKnownTranscriptExtension(lastPathComponent(filePath))
      const ownTranscript = conversationId === undefined
        ? undefined
        : leaf === conversationId || leaf === getSafeConversationId(conversationId)
      void ownTranscript
    }
    if (UNSUPPORTED_BINARY_EXTENSIONS.test(filePath)) {
      const extension = filePath.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "unknown"
      return { result: { case: "error", value: { errorMessage: `Cannot read binary files of type ${extension}` } } }
    }
    let offset: number | undefined
    let limit: number | undefined
    if ("line_range" in rawArgs && rawArgs.line_range !== undefined) {
      offset = rawArgs.line_range[0]
      limit = rawArgs.line_range[1] - rawArgs.line_range[0] + 1
    } else {
      offset = "offset" in rawArgs ? rawArgs.offset : undefined
      limit = "limit" in rawArgs ? rawArgs.limit : undefined
    }
    const includeLineNumbers = "include_line_numbers" in rawArgs ? rawArgs.include_line_numbers : undefined
    const baseToolCall: ReadToolCallModel = {
      args: {
        path: filePath,
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
        ...(includeLineNumbers === undefined ? {} : { includeLineNumbers }),
      },
    }
    let errorCount = 0
    let blobBackedReturnedByteCount: number | undefined

    const result = await interactionHandler.executeToolCall(
      span.ctx,
      baseToolCall,
      meta.toolCallId,
      async context => {
        const execResult: ReadExecutionResultModel = await readExecutor.execute(context, {
          path: filePath,
          toolCallId: meta.toolCallId,
          ...(offset === undefined ? {} : { offset }),
          ...(limit === undefined ? {} : { limit }),
        }, {
          execId: generateSeededUuid(meta.toolCallId),
          ...(meta.hookContextCollector === undefined ? {} : { hookContextCollector: meta.hookContextCollector }),
        })
        if (execResult.result.case !== "success") {
          errorCount += 1
          switch (execResult.result.case) {
            case "error":
              throw new ToolCallError({
                clientVisibleErrorMessage: execResult.result.value.error,
                modelVisibleErrorMessage: execResult.result.value.error,
                error: execResult.result.value.error,
              })
            case "rejected":
              throw new ToolCallRejectedError(execResult.result.value.reason || "Read operation rejected")
            case "fileNotFound":
              throw new ToolCallUnexpectedEnvironmentError("File not found")
            case "permissionDenied":
              throw new ToolCallUnexpectedEnvironmentError("Permission denied")
            case "invalidFile":
              throw new ToolCallUnexpectedEnvironmentError(execResult.result.value.reason || "Path is not a valid file to read")
            case undefined:
              throw new Error("Unknown error")
          }
        }
        const success = execResult.result.value
        const resolvedPath = success.path
        const fileSize = Number(success.fileSize)
        const output = success.output
        if (output === undefined) {
          errorCount += 1
          throw new ToolCallUnexpectedEnvironmentError("Unknown output type")
        }
        let pdfContentOverride: string | undefined
        if (output.case === "data") {
          if (isPdfBinary(output.value, resolvedPath)) {
            const extractor = options.pdfTextExtractor
            if (extractor === undefined) throw new TypeError("Read PDF worker is not bound")
            const cached = pdfTextCache.get(resolvedPath)
            pdfContentOverride = cached ?? normalizeLineEndings(await extractor(output.value))
            if (cached === undefined) pdfTextCache.set(resolvedPath, pdfContentOverride)
          } else {
            // Bytes with a store available become a blob reference rather than travelling inline.
            const blobStore = meta.stateHandler?.getBlobStore?.()
            if (blobStore !== undefined) {
              blobBackedReturnedByteCount = output.value.byteLength
              const blobId = success.outputBlobId && success.outputBlobId.length > 0
                ? success.outputBlobId
                : await getBlobId(output.value)
              if (success.outputBlobId && success.outputBlobId.length > 0) {
                await blobStore.setBlobLocallyOnly(context, blobId, output.value)
              } else {
                await blobStore.setBlob(context, blobId, output.value)
              }
              return { result: { case: "success", value: { output: { case: "dataBlobId", value: blobId }, fileSize, path: resolvedPath } } }
            }
            return { result: { case: "success", value: { output: { case: "data", value: output.value }, fileSize, path: resolvedPath } } }
          }
        }
        if (pdfContentOverride === undefined && output.case !== "content") {
          errorCount += 1
          throw new ToolCallUnexpectedEnvironmentError("Unknown output type")
        }
        const content = pdfContentOverride ?? (output.case === "content" ? output.value : "")
        if (content === "" && success.rangeApplied !== true) {
          return createSuccessResult("", 0, fileSize, resolvedPath, undefined, includeLineNumbers)
        }
        const totalLines = success.rangeApplied === true ? success.totalLines : content.split("\n").length
        // A range the executor already applied is reported as it is; otherwise the slice is taken here.
        if (success.rangeApplied === true) {
          const executorSlice = computeReadSlice(totalLines, offset, limit)
          const executorRange = executorSlice?.readRange ?? { startLine: 1, endLine: totalLines }
          return createSuccessResult(content, totalLines, fileSize, resolvedPath, executorRange, includeLineNumbers)
        }
        const slice = computeReadSlice(totalLines, offset, limit)
        if (slice !== undefined) {
          return createSuccessResult(
            content.split("\n").slice(slice.startIndex, slice.endIndex).join("\n"),
            totalLines,
            fileSize,
            resolvedPath,
            slice.readRange,
            includeLineNumbers,
          )
        }
        const readRange = { startLine: 1, endLine: totalLines }
        const blobStore = meta.stateHandler?.getBlobStore?.()
        if (blobStore !== undefined &&
            content.length > READ_OUTPUT_BOUNDS.spillToBlobAboveCharacters &&
            content.length <= READ_OUTPUT_BOUNDS.maximumCharacters) {
          const contentBytes = new TextEncoder().encode(content)
          blobBackedReturnedByteCount = contentBytes.byteLength
          const blobId = success.outputBlobId && success.outputBlobId.length > 0
            ? success.outputBlobId
            : await getBlobId(contentBytes)
          if (success.outputBlobId && success.outputBlobId.length > 0) {
            await blobStore.setBlobLocallyOnly(context, blobId, contentBytes)
          } else {
            await blobStore.setBlob(context, blobId, contentBytes)
          }
          return {
            result: {
              case: "success",
              value: {
                output: { case: "contentBlobId", value: blobId },
                totalLines,
                fileSize,
                path: resolvedPath,
                readRange,
                ...(includeLineNumbers === undefined ? {} : { includeLineNumbers }),
              },
            },
          }
        }
        return createSuccessResult(content, totalLines, fileSize, resolvedPath, readRange, includeLineNumbers)
      },
      meta.hookContextCollector,
    )

    if (result.result?.case === "success") {
      const resolvedPath = result.result.value.path
      meta.stateHandler?.recordReadPath?.(resolvedPath)
      meta.stepReadPathDedup?.add(resolvedPath)
      // The rules and skills that belong to this file are attached to the result, not looked up again later.
      const rules = fromInteropReadRules(meta.rules ?? [])
      const relatedRules = rules.filter(rule =>
        rule.fullPath !== undefined && normalizeComparablePath(rule.fullPath) === normalizeComparablePath(resolvedPath))
      result.result.value.relatedRules = relatedRules
      result.result.value.relatedRulePaths = relatedRules.flatMap(rule => (rule.fullPath === undefined ? [] : [rule.fullPath]))
      const eligibleSkills = filterItemsForRunEnvironment(Array.from(meta.agentSkills ?? []), meta.stateHandler?.agentType)
      const relatedSkills = eligibleSkills.filter(skill =>
        skill.disableModelInvocation !== true &&
        skill.parseError === undefined &&
        skill.fullPath !== undefined &&
        normalizeComparablePath(skill.fullPath) === normalizeComparablePath(resolvedPath))
      renderer.rememberRelatedSkills(result.result.value, relatedSkills)
      if (resolvedPath.endsWith("SKILL.md")) {
        const skill = matchingSkill(resolvedPath, meta.agentSkills)
        getAgentEventTracker(span.ctx).trackSkillUsed(span.ctx, {})
        recordSkillApplied(span.ctx, {
          entrypoint: "agent_read",
          ...(meta.stateHandler === undefined ? {} : { stateHandler: meta.stateHandler }),
          skillId: getSkillIdFromPath(resolvedPath),
          skillSource: classifyInteropSkillSourcePath(resolvedPath),
          ...(skill?.plugin === undefined ? {} : { plugin: skill.plugin }),
          ...(skill?.marketplace === undefined ? {} : { marketplace: skill.marketplace }),
          ...(skill?.pluginId === undefined ? {} : { pluginId: skill.pluginId }),
          ...(skill?.marketplaceId === undefined ? {} : { marketplaceId: skill.marketplaceId }),
        })
      }
    }
    readTotalCounter.increment(span.ctx, 1)
    readErrorsDistribution.histogram(span.ctx, errorCount)
    if (isMcpReadPath(filePath) && result.result?.case === "success" && result.result.value.output?.case === "content") {
      trackMcpDirectoryResponseBytes(span.ctx, Buffer.byteLength(result.result.value.output.value, "utf8"), "read")
    }
    void blobBackedReturnedByteCount
    return result
  }

  const render = async (context: Context, wireValue: unknown, props: ReadRenderProps = {}): Promise<unknown> =>
    await renderer.render(context, fromInteropReadToolResult(wireValue), props)

  return createZodAgentTool(options.toolIdentifier ?? "READ", {
    name,
    descriptionGenerator: () => description,
    parameters: schema,
    execute: withSafeParsedArgs(schema, async (context, rawHandler, rawArgs, rawMeta) => {
      const result = await execute(
        context,
        createReadConversationPort(rawHandler),
        rawArgs as ReadArgsLike,
        rawMeta as ReadMetadata,
      )
      return toInteropReadToolResult(result)
    }, toInteropReadToolCall({})),
    render,
    serializeError: (error: unknown) => toInteropReadToolErrorCall(error instanceof Error ? error.message : String(error)),
  } as never)
}

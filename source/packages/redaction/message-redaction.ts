/**
 * Messages that can be handed around without their text being readable.
 *
 * A conversation is redacted once, at the boundary where it leaves the parts of the platform that
 * are allowed to see it, and from then on it travels as a structurally identical message whose text
 * parts are `RedactedString`s. Rebuilding the plain message is a second, explicit step
 * (`fromRedactedCoreMessage`) that asks for a purpose — so "who may read this" is answered at the
 * point of reading, not at the point of sending.
 *
 * Redaction is memoized by object identity per privacy context: the same message under the same mode
 * produces the same redacted message, which keeps identity comparisons and downstream caches intact.
 */

import { DataClassification, type PrivacyCapability } from "./classification.ts"
import { createRedactedString } from "./create.ts"
import type { PrivacyMode } from "./privacy-mode.ts"
import { toPrivacyContext, type PrivacyContext } from "./privacy-context.ts"
import { isRedactedString, RedactedString, type RedactedUnwrapOptions } from "./redacted-values.ts"
import { getRedactionAwareDisplayValue } from "./should-redact.ts"

type LooseObject = Record<string, unknown>
type ProviderOptions = unknown

export interface CoreMessageLike extends LooseObject {
  readonly role: string
  readonly content: unknown
  readonly providerOptions?: ProviderOptions
  readonly id?: unknown
}

interface ContentPart extends LooseObject {
  readonly type: string
}

interface RedactedCoreMessageLike extends LooseObject {
  /** The mode this message was redacted under; carried so a rebuild cannot guess it. */
  readonly _privacyMode: PrivacyMode
  readonly role: string
  readonly content: unknown
  readonly providerOptions?: ProviderOptions
  readonly id?: unknown
}

interface ExperimentalContentItem extends LooseObject {
  readonly type: string
}

class RedactedTextPart {
  readonly text: RedactedString
  readonly providerOptions: ProviderOptions
  readonly type: "text"

  constructor(text: RedactedString, providerOptions: ProviderOptions) {
    this.text = text
    this.providerOptions = providerOptions
    this.type = "text"
  }

  toString(): string { return String(this.text) }
}

/** Media parts keep their payload as-is; only their printed form is redaction-aware. */
abstract class RedactedMediaPart {
  readonly type: "image" | "file"
  readonly providerOptions: ProviderOptions
  readonly __privacyContext: PrivacyContext
  private readonly placeheldField: "image" | "file"

  protected constructor(
    type: "image" | "file",
    providerOptions: ProviderOptions,
    modeOrContext: PrivacyMode | PrivacyContext,
    placeheldField: "image" | "file",
  ) {
    this.type = type
    this.providerOptions = providerOptions
    this.__privacyContext = toPrivacyContext(modeOrContext)
    this.placeheldField = placeheldField
  }

  protected abstract readMedia(): string

  protected printedValue(): string {
    return getRedactionAwareDisplayValue({
      privacyMode: this.__privacyContext.privacyMode,
      classification: DataClassification.CODE,
      fieldName: this.placeheldField,
      unredactedValue: this.readMedia(),
      enforceRedaction: this.__privacyContext.enforceRedaction,
    })
  }

  toString(): string { return this.printedValue() }
  toJSON(): string { return this.printedValue() }
}

class RedactedImagePart extends RedactedMediaPart {
  readonly image: unknown
  readonly mimeType: unknown

  constructor(image: unknown, mimeType: unknown, providerOptions: ProviderOptions, modeOrContext: PrivacyMode | PrivacyContext) {
    super("image", providerOptions, modeOrContext, "image")
    this.image = image
    this.mimeType = mimeType
  }

  protected readMedia(): string {
    return typeof this.image === "string" ? this.image : String(this.image)
  }
}

class RedactedFilePart extends RedactedMediaPart {
  readonly data: unknown
  readonly mimeType: unknown

  constructor(data: unknown, mimeType: unknown, providerOptions: ProviderOptions, modeOrContext: PrivacyMode | PrivacyContext) {
    super("file", providerOptions, modeOrContext, "file")
    this.data = data
    this.mimeType = mimeType
  }

  protected readMedia(): string {
    return typeof this.data === "string" ? this.data : String(this.data)
  }
}

class RedactedToolCallPart {
  readonly type: "tool-call"
  readonly toolCallId: unknown
  readonly toolName: unknown
  readonly args: RedactedString
  readonly providerOptions: ProviderOptions

  constructor(params: {
    toolCallId: unknown
    toolName: unknown
    args: RedactedString
    providerOptions: ProviderOptions
  }) {
    this.type = "tool-call"
    this.toolCallId = params.toolCallId
    this.toolName = params.toolName
    this.args = params.args
    this.providerOptions = params.providerOptions
  }

  toString(): string { return String(this.args) }
}

class RedactedToolResultPart {
  readonly type: "tool-result"
  readonly toolCallId: unknown
  readonly toolName: unknown
  readonly result: RedactedString
  readonly isError: unknown
  readonly providerOptions: ProviderOptions
  readonly experimental_content: readonly ExperimentalContentItem[] | undefined

  constructor(params: {
    toolCallId: unknown
    toolName: unknown
    result: RedactedString
    isError: unknown
    providerOptions: ProviderOptions
    experimental_content: readonly ExperimentalContentItem[] | undefined
  }) {
    this.type = "tool-result"
    this.toolCallId = params.toolCallId
    this.toolName = params.toolName
    this.result = params.result
    this.isError = params.isError
    this.providerOptions = params.providerOptions
    this.experimental_content = params.experimental_content
  }

  toString(): string { return String(this.result) }
}

/** A part shape this build does not model: kept as redacted JSON so it survives a round trip. */
class RedactedUnknownPart {
  readonly originalType: string
  readonly data: RedactedString
  readonly type: "unknown"

  constructor(originalType: string, data: RedactedString) {
    this.originalType = originalType
    this.data = data
    this.type = "unknown"
  }

  toString(): string { return String(this.data) }
}

interface MessageCaches {
  readonly message: WeakMap<object, RedactedCoreMessageLike>
  readonly userContent: WeakMap<object, readonly unknown[]>
  readonly assistantContent: WeakMap<object, readonly unknown[]>
  readonly toolContent: WeakMap<object, readonly unknown[]>
}

const cachesByContext = new Map<string, MessageCaches>()

function cachesFor(context: PrivacyContext): MessageCaches {
  const key = `${context.privacyMode}:${context.enforceRedaction ?? "gate"}`
  const existing = cachesByContext.get(key)
  if (existing !== undefined) return existing
  const created: MessageCaches = {
    message: new WeakMap(),
    userContent: new WeakMap(),
    assistantContent: new WeakMap(),
    toolContent: new WeakMap(),
  }
  cachesByContext.set(key, created)
  return created
}

function memoize<T>(cache: WeakMap<object, T>, key: object, build: () => T): T {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const value = build()
  cache.set(key, value)
  return value
}

export function toRedactedCoreMessage(
  message: CoreMessageLike,
  modeOrContext: PrivacyMode | PrivacyContext,
): RedactedCoreMessageLike {
  const context = toPrivacyContext(modeOrContext)
  const caches = cachesFor(context)
  const cached = caches.message.get(message)
  if (cached !== undefined) return cached

  let redacted: RedactedCoreMessageLike
  switch (message.role) {
    case "user": redacted = toRedactedUserMessage(message, context, caches); break
    case "assistant": redacted = toRedactedAssistantMessage(message, context, caches); break
    case "tool": redacted = toRedactedToolMessage(message, context, caches); break
    case "system": redacted = toRedactedSystemMessage(message, context); break
    default: throw new Error(`Unhandled CoreMessage role: ${message.role}`)
  }
  caches.message.set(message, redacted)
  return redacted
}

export function toRedactedCoreMessages(
  messages: readonly CoreMessageLike[],
  modeOrContext: PrivacyMode | PrivacyContext,
): RedactedCoreMessageLike[] {
  return messages.map(message => toRedactedCoreMessage(message, modeOrContext))
}

export function fromRedactedCoreMessage(
  message: RedactedCoreMessageLike,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike {
  switch (message.role) {
    case "user": return fromRedactedUserMessage(message, purpose, options)
    case "assistant": return fromRedactedAssistantMessage(message, purpose, options)
    case "tool": return fromRedactedToolMessage(message, purpose, options)
    case "system": return fromRedactedSystemMessage(message, purpose, options)
    default: throw new Error(`Unhandled RedactedCoreMessage role: ${message.role}`)
  }
}

export function fromRedactedCoreMessages(
  messages: readonly RedactedCoreMessageLike[],
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike[] {
  return messages.map(message => fromRedactedCoreMessage(message, purpose, options))
}

function requireRedactedString(value: unknown, where: string): RedactedString {
  if (!isRedactedString(value)) throw new Error(`Expected a redacted string for ${where}`)
  return value
}

/** Content is either text or a list of parts; anything else is a malformed message. */
function contentParts(content: unknown, role: string): readonly ContentPart[] {
  if (!Array.isArray(content)) throw new Error(`Expected content parts for a ${role} message`)
  return content as readonly ContentPart[]
}

/** JSON when it parses, the raw text otherwise: a tool's result is not required to be JSON. */
function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toRedactedUserContentPart(part: ContentPart, context: PrivacyContext): unknown {
  switch (part.type) {
    case "text":
      return new RedactedTextPart(
        createRedactedString(part.text as string, DataClassification.CODE, "user_text", context),
        part.providerOptions,
      )
    case "image":
      return new RedactedImagePart(part.image, part.mimeType, part.providerOptions, context)
    case "file":
      return new RedactedFilePart(part.data, part.mimeType, part.providerOptions, context)
    default:
      throw new Error(`Unhandled user content part type: ${part.type}`)
  }
}

function toRedactedAssistantContentPart(part: ContentPart, context: PrivacyContext): unknown {
  switch (part.type) {
    case "text":
      return new RedactedTextPart(
        createRedactedString(part.text as string, DataClassification.CODE, "assistant_text", context),
        part.providerOptions,
      )
    case "tool-call":
      return new RedactedToolCallPart({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: createRedactedString(
          JSON.stringify(part.args) as string,
          DataClassification.CODE,
          "tool_call_args",
          context,
        ),
        providerOptions: part.providerOptions,
      })
    default:
      return new RedactedUnknownPart(
        part.type,
        createRedactedString(JSON.stringify(part) as string, DataClassification.CODE, `assistant_${part.type}`, context),
      )
  }
}

function toRedactedToolResultPart(part: ContentPart, context: PrivacyContext): RedactedToolResultPart {
  const result = typeof part.result === "string" ? part.result : JSON.stringify(part.result) as string
  const experimentalContent = part.experimental_content as readonly ExperimentalContentItem[] | undefined
  return new RedactedToolResultPart({
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    result: createRedactedString(result, DataClassification.CODE, "tool_result", context),
    isError: part.isError,
    providerOptions: part.providerOptions,
    experimental_content: experimentalContent?.map(item => {
      if (item.type === "text" && typeof item.text === "string") {
        return {
          type: "text",
          text: createRedactedString(item.text, DataClassification.CODE, "experimental_content_text", context),
        }
      }
      return item
    }),
  })
}

function toRedactedUserMessage(
  message: CoreMessageLike,
  context: PrivacyContext,
  caches: MessageCaches,
): RedactedCoreMessageLike {
  if (typeof message.content === "string") {
    return {
      _privacyMode: context.privacyMode,
      role: "user",
      content: createRedactedString(message.content, DataClassification.CODE, "user_content", context),
      providerOptions: message.providerOptions,
    }
  }
  const content = contentParts(message.content, "user")
  return {
    _privacyMode: context.privacyMode,
    role: "user",
    content: memoize(caches.userContent, content, () =>
      content.map(part => toRedactedUserContentPart(part, context))),
    providerOptions: message.providerOptions,
  }
}

function toRedactedAssistantMessage(
  message: CoreMessageLike,
  context: PrivacyContext,
  caches: MessageCaches,
): RedactedCoreMessageLike {
  if (typeof message.content === "string") {
    return {
      _privacyMode: context.privacyMode,
      role: "assistant",
      content: createRedactedString(message.content, DataClassification.CODE, "assistant_content", context),
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }),
    }
  }
  const content = contentParts(message.content, "assistant")
  return {
    _privacyMode: context.privacyMode,
    role: "assistant",
    content: memoize(caches.assistantContent, content, () =>
      content.map(part => toRedactedAssistantContentPart(part, context))),
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }),
  }
}

function toRedactedToolMessage(
  message: CoreMessageLike,
  context: PrivacyContext,
  caches: MessageCaches,
): RedactedCoreMessageLike {
  const content = contentParts(message.content, "tool")
  return {
    _privacyMode: context.privacyMode,
    role: "tool",
    content: memoize(caches.toolContent, content, () =>
      content.map(part => toRedactedToolResultPart(part, context))),
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }),
  }
}

function toRedactedSystemMessage(message: CoreMessageLike, context: PrivacyContext): RedactedCoreMessageLike {
  return {
    _privacyMode: context.privacyMode,
    role: "system",
    content: createRedactedString(message.content as string, DataClassification.CODE, "system_content", context),
    providerOptions: message.providerOptions,
  }
}

function fromRedactedUserContentPart(
  part: ContentPart,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): LooseObject {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: requireRedactedString(part.text, "user text").unwrap(purpose, options),
        providerOptions: part.providerOptions,
      }
    case "image":
      return { type: "image", image: part.image, mimeType: part.mimeType, providerOptions: part.providerOptions }
    case "file":
      return { type: "file", data: part.data, mimeType: part.mimeType, providerOptions: part.providerOptions }
    default:
      throw new Error(`Unhandled redacted user content part type: ${part.type}`)
  }
}

function fromRedactedAssistantContentPart(
  part: ContentPart,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): unknown {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: requireRedactedString(part.text, "assistant text").unwrap(purpose, options),
        ...(part.providerOptions === undefined ? {} : { providerOptions: part.providerOptions }),
      }
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: parseJsonOrRaw(requireRedactedString(part.args, "tool call args").unwrap(purpose, options)),
        ...(part.providerOptions === undefined ? {} : { providerOptions: part.providerOptions }),
      }
    case "unknown":
      return parseJsonOrRaw(requireRedactedString(part.data, "unknown part").unwrap(purpose, options))
    default:
      throw new Error(`Unhandled redacted assistant content part type: ${part.type}`)
  }
}

function fromRedactedUserMessage(
  message: RedactedCoreMessageLike,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike {
  if (isRedactedString(message.content)) {
    return {
      role: "user",
      content: message.content.unwrap(purpose, options),
      providerOptions: message.providerOptions,
    }
  }
  const content = contentParts(message.content, "user").map(part =>
    fromRedactedUserContentPart(part, purpose, options))
  return { role: "user", content, providerOptions: message.providerOptions }
}

function fromRedactedAssistantMessage(
  message: RedactedCoreMessageLike,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike {
  const content = isRedactedString(message.content)
    ? message.content.unwrap(purpose, options)
    : contentParts(message.content, "assistant").map(part => fromRedactedAssistantContentPart(part, purpose, options))
  return {
    role: "assistant",
    content,
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }),
  }
}

function fromRedactedToolMessage(
  message: RedactedCoreMessageLike,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike {
  const content = contentParts(message.content, "tool").map(part => {
    const experimentalContent = part.experimental_content as readonly ExperimentalContentItem[] | undefined
    const unwrappedExperimentalContent = experimentalContent?.map(item => {
      if (item.type === "text" && isRedactedString(item.text)) {
        return { type: "text", text: item.text.unwrap(purpose, options) }
      }
      return item
    })
    return {
      type: "tool-result",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      result: parseJsonOrRaw(requireRedactedString(part.result, "tool result").unwrap(purpose, options)),
      ...(part.isError === undefined ? {} : { isError: part.isError }),
      ...(part.providerOptions === undefined ? {} : { providerOptions: part.providerOptions }),
      ...(unwrappedExperimentalContent === undefined ? {} : { experimental_content: unwrappedExperimentalContent }),
    }
  })
  return {
    role: "tool",
    content,
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }),
  }
}

function fromRedactedSystemMessage(
  message: RedactedCoreMessageLike,
  purpose: PrivacyCapability,
  options?: RedactedUnwrapOptions,
): CoreMessageLike {
  return {
    role: "system",
    content: requireRedactedString(message.content, "system content").unwrap(purpose, options),
    providerOptions: message.providerOptions,
  }
}

/**
 * Values that carry their own redaction.
 *
 * A `RedactedString` or `RedactedBytes` remembers what it is (classification), where it came from
 * (field name), and the privacy context it was created under. Reading it is then a negotiation with
 * policy rather than a property access: `unwrap(purpose)` either returns the bytes, returns the
 * placeholder, or refuses — and every path that would have leaked is reported (or, in development,
 * throws) instead of passing silently.
 *
 * Implicit serialization is the interesting case: string interpolation, `JSON.stringify` and `+`
 * all reach a redacted value without asking, so they render the redaction-aware display value, which
 * is the placeholder whenever policy says the value is redacted.
 */

import { allowedPurpose, type DataClassification, type PrivacyCapability } from "./classification.ts"
import { type PrivacyMode as PrivacyModeValue } from "./privacy-mode.ts"
import { resolveEnforceRedaction, toPrivacyContext, type PrivacyContext } from "./privacy-context.ts"
import { formatRedacted, getRedactionAwareDisplayValue, shouldRedact } from "./should-redact.ts"
import {
  logEnforcementSkipped,
  logImplicitSerialization,
  logUnspecifiedWarnings,
  REDACTION_MESSAGES,
  type RedactionInfo,
} from "./violations.ts"

/** Development-only strictness: throw where production would report a violation and continue. */
const IS_DEVELOPMENT =
  typeof process !== "undefined" &&
  process.env.NODE_ENV === "development" &&
  process.env.NODE_TEST_CONTEXT === undefined

export interface RedactedUnwrapOptions {
  /** Force enforcement on for this read, whatever the context and the process gate say. */
  readonly enforcing?: boolean | undefined
  /** Return the placeholder instead of refusing: for read paths that must produce something. */
  readonly redactUnallowedFieldsInsteadOfThrowing?: boolean | undefined
}

type UnwrapDecision = "allowed" | "unenforced" | "refused"

/** What both value kinds do before they hand anything out. */
abstract class RedactedValue<V> {
  readonly __classification: DataClassification
  readonly __fieldName: string
  readonly __privacyMode: PrivacyModeValue
  readonly __isRedacted: boolean
  private readonly privacyContext: PrivacyContext
  protected readonly value: V

  constructor(
    value: V,
    classification: DataClassification,
    fieldName: string,
    modeOrContext: PrivacyModeValue | PrivacyContext,
  ) {
    const context = toPrivacyContext(modeOrContext)
    this.value = value
    this.privacyContext = context
    this.__classification = classification
    this.__fieldName = fieldName
    this.__privacyMode = context.privacyMode
    this.__isRedacted = shouldRedact(context.privacyMode, classification)
  }

  getPrivacyContext(): PrivacyContext {
    return this.privacyContext.enforceRedaction === undefined
      ? { privacyMode: this.privacyContext.privacyMode }
      : { privacyMode: this.privacyContext.privacyMode, enforceRedaction: this.privacyContext.enforceRedaction }
  }

  private redactionInfo(): RedactionInfo {
    return {
      fieldName: this.__fieldName,
      classification: this.__classification,
      privacyMode: this.__privacyMode,
    }
  }

  protected decisionFor(purpose: PrivacyCapability, options?: RedactedUnwrapOptions): UnwrapDecision {
    logUnspecifiedWarnings(this.redactionInfo())
    if (allowedPurpose(this.__privacyMode, purpose, this.__classification)) return "allowed"
    const enforce = options?.enforcing || resolveEnforceRedaction(this.privacyContext, this.__classification)
    if (!enforce) {
      if (!IS_DEVELOPMENT) logEnforcementSkipped(this.redactionInfo())
      return "unenforced"
    }
    return "refused"
  }

  protected refusal(purpose: PrivacyCapability): Error {
    return new Error(
      `Unwrap not allowed for purpose ${purpose} with classification ${this.__classification} and privacy mode ${this.__privacyMode}`,
    )
  }

  protected displayValue(): string {
    return getRedactionAwareDisplayValue({
      privacyMode: this.privacyContext.privacyMode,
      classification: this.__classification,
      fieldName: this.__fieldName,
      unredactedValue: String(this.value),
      enforceRedaction: this.privacyContext.enforceRedaction,
    })
  }

  /** Reaching a value without unwrapping it is a violation when policy says it is redacted. */
  protected reportImplicitSerialization(serializationPath: string): void {
    if (!this.__isRedacted || resolveEnforceRedaction(this.privacyContext, this.__classification)) return
    if (IS_DEVELOPMENT) {
      throw new Error(
        `${REDACTION_MESSAGES.IMPLICIT_SERIALIZATION_DEV} (field=${this.__fieldName}, classification=${this.__classification}, path=${serializationPath})`,
      )
    }
    logImplicitSerialization(this.redactionInfo(), serializationPath)
  }
}

function stringAtIndex(value: string, index: number): string | undefined {
  const normalized = index < 0 ? value.length + index : index
  if (normalized < 0 || normalized >= value.length) return undefined
  return value[normalized]
}

export class RedactedString extends RedactedValue<string> {
  constructor(
    value: string,
    classification: DataClassification,
    fieldName: string,
    modeOrContext: PrivacyModeValue | PrivacyContext,
  ) {
    super(value, classification, fieldName, modeOrContext)
  }

  get length(): number {
    return this.value.length
  }

  get empty(): boolean {
    return this.value.length === 0
  }

  unwrap(purpose: PrivacyCapability, options?: RedactedUnwrapOptions): string {
    switch (this.decisionFor(purpose, options)) {
      case "allowed": return this.value
      case "unenforced": return this.value
      case "refused":
        return options?.redactUnallowedFieldsInsteadOfThrowing
          ? formatRedacted(this.__fieldName)
          : (() => { throw this.refusal(purpose) })()
    }
  }

  /** A copy under a derived field name: callers use this to flag where the value went. */
  __clone(newValue: string): RedactedString {
    return new RedactedString(newValue, this.__classification, `${this.__fieldName}.clone`, this.getPrivacyContext())
  }

  safeTransform(transform: (value: string) => string): RedactedString {
    return new RedactedString(transform(this.value), this.__classification, this.__fieldName, this.getPrivacyContext())
  }

  override toString(): string {
    this.reportImplicitSerialization("toString")
    return this.displayValue()
  }

  toJSON(): string {
    this.reportImplicitSerialization("toJSON")
    return this.displayValue()
  }

  override valueOf(): string {
    this.reportImplicitSerialization("valueOf")
    return this.displayValue()
  }

  [Symbol.toPrimitive](hint: string): string | number {
    if (hint === "string" || hint === "default") {
      this.reportImplicitSerialization("toPrimitive")
      return this.displayValue()
    }
    return Number.NaN
  }

  get [Symbol.toStringTag](): string {
    return "RedactedString"
  }

  startsWith(searchString: string, position?: number): boolean { return this.value.startsWith(searchString, position) }
  endsWith(searchString: string, endPosition?: number): boolean { return this.value.endsWith(searchString, endPosition) }
  includes(searchString: string, position?: number): boolean { return this.value.includes(searchString, position) }
  indexOf(searchString: string, position?: number): number { return this.value.indexOf(searchString, position) }
  lastIndexOf(searchString: string, position?: number): number { return this.value.lastIndexOf(searchString, position) }
  search(regexp: string | RegExp): number { return this.value.search(regexp) }
  localeCompare(that: string, locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions): number {
    return this.value.localeCompare(that, locales, options)
  }

  trim(): RedactedString { return this.#rewrap(this.value.trim()) }
  trimStart(): RedactedString { return this.#rewrap(this.value.trimStart()) }
  trimLeft(): RedactedString { return this.#rewrap(this.value.trimStart()) }
  trimEnd(): RedactedString { return this.#rewrap(this.value.trimEnd()) }
  trimRight(): RedactedString { return this.#rewrap(this.value.trimEnd()) }
  slice(start?: number, end?: number): RedactedString { return this.#rewrap(this.value.slice(start, end)) }
  substring(start: number, end?: number): RedactedString { return this.#rewrap(this.value.substring(start, end)) }
  substr(start: number, length?: number): RedactedString { return this.#rewrap(this.value.substr(start, length)) }
  split(separator: string | RegExp, limit?: number): RedactedString[] {
    return this.value.split(separator, limit).map(part => this.#rewrap(part))
  }
  toLowerCase(): RedactedString { return this.#rewrap(this.value.toLowerCase()) }
  toUpperCase(): RedactedString { return this.#rewrap(this.value.toUpperCase()) }
  toLocaleLowerCase(locales?: Intl.LocalesArgument): RedactedString { return this.#rewrap(this.value.toLocaleLowerCase(locales)) }
  toLocaleUpperCase(locales?: Intl.LocalesArgument): RedactedString { return this.#rewrap(this.value.toLocaleUpperCase(locales)) }
  replace(searchValue: string | RegExp, replaceValue: string): RedactedString {
    return this.#rewrap(this.value.replace(searchValue, replaceValue))
  }
  replaceAll(searchValue: string | RegExp, replaceValue: string): RedactedString {
    return this.#rewrap(this.value.replaceAll(searchValue, replaceValue))
  }
  padStart(maxLength: number, fillString?: string): RedactedString { return this.#rewrap(this.value.padStart(maxLength, fillString)) }
  padEnd(maxLength: number, fillString?: string): RedactedString { return this.#rewrap(this.value.padEnd(maxLength, fillString)) }
  repeat(count: number): RedactedString { return this.#rewrap(this.value.repeat(count)) }
  normalize(form?: "NFC" | "NFD" | "NFKC" | "NFKD"): RedactedString { return this.#rewrap(this.value.normalize(form)) }
  concat(...strings: string[]): RedactedString { return this.#rewrap(this.value.concat(...strings)) }
  charAt(position: number): RedactedString { return this.#rewrap(this.value.charAt(position)) }
  at(index: number): RedactedString | undefined {
    const character = stringAtIndex(this.value, index)
    return character === undefined ? undefined : this.#rewrap(character)
  }

  #rewrap(newValue: string): RedactedString {
    return new RedactedString(newValue, this.__classification, this.__fieldName, this.getPrivacyContext())
  }
}

export class RedactedBytes extends RedactedValue<Uint8Array> {
  constructor(
    value: Uint8Array,
    classification: DataClassification,
    fieldName: string,
    modeOrContext: PrivacyModeValue | PrivacyContext,
  ) {
    super(value, classification, fieldName, modeOrContext)
  }

  get length(): number {
    return this.value.length
  }

  get empty(): boolean {
    return this.value.length === 0
  }

  unwrap(purpose: PrivacyCapability, options?: RedactedUnwrapOptions): Uint8Array {
    switch (this.decisionFor(purpose, options)) {
      case "allowed": return this.value
      case "unenforced": return this.value
      case "refused":
        return options?.redactUnallowedFieldsInsteadOfThrowing
          ? new Uint8Array(0)
          : (() => { throw this.refusal(purpose) })()
    }
  }

  __clone(newValue: Uint8Array): RedactedBytes {
    return new RedactedBytes(newValue, this.__classification, this.__fieldName, this.getPrivacyContext())
  }

  safeTransform(transform: (value: Uint8Array) => Uint8Array): RedactedBytes {
    return new RedactedBytes(transform(this.value), this.__classification, this.__fieldName, this.getPrivacyContext())
  }
}

export function isRedactedString(value: unknown): value is RedactedString {
  return value instanceof RedactedString
}

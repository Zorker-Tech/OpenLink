import { test } from "node:test"
import assert from "node:assert/strict"

import {
  allowedPurpose,
  DataClassification,
  PrivacyCapability,
  SENSITIVE_CLASSIFICATIONS,
} from "../../source/packages/redaction/classification.ts"
import { createRedactedBytes, createRedactedString, safeString } from "../../source/packages/redaction/create.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  privacyContextFromMode,
  resolveEnforceRedaction,
  setRedactionEnforcementGate,
  toPrivacyContext,
} from "../../source/packages/redaction/privacy-context.ts"
import { isRedactedString, RedactedBytes, RedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { formatRedacted, getRedactionAwareDisplayValue, shouldRedact } from "../../source/packages/redaction/should-redact.ts"
import {
  REDACTION_MESSAGES,
  setRedactionLogger,
  type RedactionLogger,
} from "../../source/packages/redaction/violations.ts"

function capturingLogger(): { logger: RedactionLogger; reports: { attributes: Record<string, unknown>; message: string }[] } {
  const reports: { attributes: Record<string, unknown>; message: string }[] = []
  return { reports, logger: { info: (attributes, message) => reports.push({ attributes, message }) } }
}

test("credentials and unclassified values are never readable for a storage purpose", () => {
  for (const mode of Object.values(PrivacyMode)) {
    for (const purpose of [PrivacyCapability.STORAGE_FOR_TRAINING, PrivacyCapability.STORAGE_FOR_LOGGING, PrivacyCapability.STORAGE_FOR_USAGE]) {
      assert.equal(allowedPurpose(mode, purpose, DataClassification.CREDENTIALS), false, `credentials in ${mode}`)
      assert.equal(allowedPurpose(mode, purpose, DataClassification.UNSPECIFIED), false, `unspecified in ${mode}`)
    }
    assert.equal(allowedPurpose(mode, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, DataClassification.CREDENTIALS), true)
  }
})

test("safe values are readable and the escape hatch bypasses every other rule", () => {
  assert.equal(allowedPurpose(PrivacyMode.NO_STORAGE, PrivacyCapability.STORAGE_FOR_LOGGING, DataClassification.SAFE), true)
  assert.equal(allowedPurpose(PrivacyMode.UNSPECIFIED, PrivacyCapability.STORAGE_FOR_TRAINING, DataClassification.SAFE), true)
  assert.equal(
    allowedPurpose(PrivacyMode.NO_TRAINING, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, DataClassification.CODE),
    true,
  )
})

test("the allowed purposes depend on the mode once the value is sensitive", () => {
  const code = DataClassification.CODE
  const path = DataClassification.PATH
  assert.equal(allowedPurpose(PrivacyMode.NO_STORAGE, PrivacyCapability.STORAGE_FOR_USAGE, code), false)
  assert.equal(allowedPurpose(PrivacyMode.UNSPECIFIED, PrivacyCapability.STORAGE_FOR_USAGE, code), false)

  assert.equal(allowedPurpose(PrivacyMode.NO_TRAINING, PrivacyCapability.STORAGE_FOR_USAGE, code), true)
  assert.equal(allowedPurpose(PrivacyMode.NO_TRAINING, PrivacyCapability.STORAGE_FOR_TRAINING, code), false)
  assert.equal(allowedPurpose(PrivacyMode.NO_TRAINING, PrivacyCapability.STORAGE_FOR_LOGGING, path), true)
  assert.equal(allowedPurpose(PrivacyMode.NO_TRAINING, PrivacyCapability.STORAGE_FOR_LOGGING, code), false)

  for (const mode of [PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED]) {
    for (const purpose of [PrivacyCapability.STORAGE_FOR_TRAINING, PrivacyCapability.STORAGE_FOR_LOGGING, PrivacyCapability.STORAGE_FOR_USAGE]) {
      assert.equal(allowedPurpose(mode, purpose, code), true, `${mode} allows ${purpose}`)
    }
  }
})

test("an unknown purpose or mode is refused loudly rather than guessed", () => {
  assert.throws(
    () => allowedPurpose(PrivacyMode.NO_STORAGE, "storage_for_something" as PrivacyCapability, DataClassification.CODE),
    /Unknown purpose: storage_for_something/,
  )
  assert.throws(
    () => allowedPurpose(9 as never, PrivacyCapability.STORAGE_FOR_USAGE, DataClassification.CODE),
    /Unknown privacy mode: 9/,
  )
})

test("what gets redacted follows the classification first and the mode second", () => {
  assert.ok(SENSITIVE_CLASSIFICATIONS.includes(DataClassification.CODE))
  assert.ok(!SENSITIVE_CLASSIFICATIONS.includes(DataClassification.SAFE))

  for (const mode of Object.values(PrivacyMode)) {
    assert.equal(shouldRedact(mode, DataClassification.CREDENTIALS), true)
    assert.equal(shouldRedact(mode, DataClassification.UNSPECIFIED), true)
    assert.equal(shouldRedact(mode, DataClassification.SAFE), false)
  }
  assert.equal(shouldRedact(PrivacyMode.NO_STORAGE, DataClassification.CODE), true)
  assert.equal(shouldRedact(PrivacyMode.NO_TRAINING, DataClassification.PROVIDER_INFO), true)
  assert.equal(shouldRedact(PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, DataClassification.CODE), false)
  assert.equal(shouldRedact(PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED, DataClassification.PATH), false)
})

test("enforcement is explicit when the context says so, otherwise it depends on the process gate", () => {
  const context = privacyContextFromMode(PrivacyMode.NO_STORAGE)
  assert.equal(resolveEnforceRedaction(context, DataClassification.CODE), false, "no gate installed yet")
  assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true }, DataClassification.CODE), true)
  assert.equal(resolveEnforceRedaction({ privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, enforceRedaction: false }, DataClassification.CODE), false)

  try {
    setRedactionEnforcementGate(() => true)
    assert.equal(resolveEnforceRedaction(context, DataClassification.CODE), true)
    assert.equal(
      resolveEnforceRedaction(privacyContextFromMode(PrivacyMode.UNSPECIFIED), DataClassification.CODE),
      false,
      "an unresolved mode never enforces",
    )
  } finally {
    setRedactionEnforcementGate(() => undefined)
  }
  assert.equal(resolveEnforceRedaction(context, DataClassification.CODE), false, "a gate can decide to abstain")
})

test("a redacted string records how it was classified and where it came from", () => {
  const value = createRedactedString("hunter2", DataClassification.CREDENTIALS, "password", PrivacyMode.NO_STORAGE)
  assert.equal(value.__classification, DataClassification.CREDENTIALS)
  assert.equal(value.__fieldName, "password")
  assert.equal(value.__privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(value.__isRedacted, true)
  assert.equal(value.length, 7)
  assert.equal(value.empty, false)
  assert.deepEqual(value.getPrivacyContext(), { privacyMode: PrivacyMode.NO_STORAGE })
  assert.equal(isRedactedString(value), true)
  assert.equal(isRedactedString("hunter2"), false)

  const explicit = createRedactedString("x", DataClassification.SAFE, "label", {
    privacyMode: PrivacyMode.NO_STORAGE,
    enforceRedaction: true,
  })
  assert.deepEqual(explicit.getPrivacyContext(), { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true })
})

test("toPrivacyContext accepts a bare mode and passes a context through", () => {
  assert.deepEqual(toPrivacyContext(PrivacyMode.NO_TRAINING), { privacyMode: PrivacyMode.NO_TRAINING })
  const context = { privacyMode: PrivacyMode.NO_STORAGE, enforceRedaction: true }
  assert.equal(toPrivacyContext(context), context)
  assert.deepEqual(privacyContextFromMode(PrivacyMode.NO_STORAGE, false), {
    privacyMode: PrivacyMode.NO_STORAGE,
    enforceRedaction: false,
  })
})

test("unwrap hands the value over when the purpose is allowed", () => {
  const value = createRedactedString("notes", DataClassification.CODE, "user_text", PrivacyMode.USAGE_DATA_TRAINING_ALLOWED)
  assert.equal(value.unwrap(PrivacyCapability.STORAGE_FOR_TRAINING), "notes")
  assert.equal(value.__isRedacted, false)
})

test("unwrap refuses what policy forbids, with the placeholder or an error", () => {
  const value = createRedactedString("secret plan", DataClassification.CODE, "user_text", {
    privacyMode: PrivacyMode.NO_STORAGE,
    enforceRedaction: true,
  })
  assert.throws(
    () => value.unwrap(PrivacyCapability.STORAGE_FOR_TRAINING),
    /Unwrap not allowed for purpose storage_for_training with classification code and privacy mode 1/,
  )
  assert.equal(
    value.unwrap(PrivacyCapability.STORAGE_FOR_TRAINING, { redactUnallowedFieldsInsteadOfThrowing: true }),
    "[redacted:user_text]",
  )
  assert.equal(formatRedacted("user_text"), "[redacted:user_text]")
  assert.throws(
    () => value.unwrap(PrivacyCapability.STORAGE_FOR_TRAINING, { enforcing: false }),
    /Unwrap not allowed/,
    "an explicit opt-out cannot override a context that enforces",
  )

  const unenforced = createRedactedString("secret plan", DataClassification.CODE, "user_text", PrivacyMode.NO_STORAGE)
  assert.equal(
    unenforced.unwrap(PrivacyCapability.STORAGE_FOR_TRAINING),
    "secret plan",
    "a context that does not enforce hands the value over",
  )
})

test("a value that would have been redacted reports every unenforced read", () => {
  const { logger, reports } = capturingLogger()
  setRedactionLogger(logger)
  try {
    const value = createRedactedString("secret", DataClassification.CODE, "user_text", PrivacyMode.NO_STORAGE)
    assert.equal(value.unwrap(PrivacyCapability.STORAGE_FOR_TRAINING), "secret")
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.message, REDACTION_MESSAGES.ENFORCEMENT_SKIPPED)
    assert.deepEqual(reports[0]?.attributes, {
      redaction_field_name: "user_text",
      redaction_classification: DataClassification.CODE,
      redaction_privacy_mode: PrivacyMode.NO_STORAGE,
      redaction_enforcement_skipped: true,
    })
  } finally {
    setRedactionLogger(undefined)
  }
})

test("an unclassified field or unresolved mode is reported as a classification gap", () => {
  const { logger, reports } = capturingLogger()
  setRedactionLogger(logger)
  try {
    createRedactedString("x", DataClassification.UNSPECIFIED, "mystery", PrivacyMode.UNSPECIFIED)
      .unwrap(PrivacyCapability.STORAGE_FOR_USAGE, { redactUnallowedFieldsInsteadOfThrowing: true })
    assert.deepEqual(reports.map(report => report.message), [
      REDACTION_MESSAGES.UNSPECIFIED_FIELD,
      REDACTION_MESSAGES.UNSPECIFIED_PRIVACY_MODE,
      REDACTION_MESSAGES.ENFORCEMENT_SKIPPED,
    ], "the gap and the unenforced read are both reported")
  } finally {
    setRedactionLogger(undefined)
  }
})

test("with no logger installed, an unenforced read says so on the console", (t) => {
  setRedactionLogger(undefined)
  const error = t.mock.method(console, "error")
  createRedactedString("secret", DataClassification.CODE, "user_text", PrivacyMode.NO_STORAGE)
    .unwrap(PrivacyCapability.STORAGE_FOR_TRAINING)
  assert.equal(error.mock.calls.length, 1)
  assert.equal(error.mock.calls[0]?.arguments[0], REDACTION_MESSAGES.LOGGER_NOT_INITIALIZED)
})

test("printing a redacted value shows the placeholder and reports the leak", () => {
  const { logger, reports } = capturingLogger()
  setRedactionLogger(logger)
  try {
    const enforced = createRedactedString("secret", DataClassification.CREDENTIALS, "token", {
      privacyMode: PrivacyMode.NO_STORAGE,
      enforceRedaction: true,
    })
    assert.equal(`${enforced}`, "[redacted:token]")
    assert.equal(JSON.stringify({ token: enforced }), '{"token":"[redacted:token]"}')
    assert.equal(enforced.valueOf(), "[redacted:token]")
    assert.equal(Number(enforced), Number.NaN)
    assert.equal(Object.prototype.toString.call(enforced), "[object RedactedString]")
    assert.equal(reports.length, 0, "an enforced read is not a violation")

    const unenforced = createRedactedString("secret", DataClassification.CODE, "user_text", PrivacyMode.NO_STORAGE)
    assert.equal(`${unenforced}`, "secret", "without enforcement there is nothing to hide behind")
    assert.equal(unenforced.toString(), "secret")
    assert.deepEqual(reports.map(report => report.message), [
      REDACTION_MESSAGES.IMPLICIT_SERIALIZATION,
      REDACTION_MESSAGES.IMPLICIT_SERIALIZATION,
    ])
    assert.deepEqual(reports.map(report => report.attributes.redaction_serialization_path), ["toPrimitive", "toString"],
      "interpolation goes through Symbol.toPrimitive, an explicit call through toString")
  } finally {
    setRedactionLogger(undefined)
  }
})

test("the string API stays usable on a redacted value and keeps its classification", () => {
  const value = createRedactedString("  Token=abc  ", DataClassification.CODE, "header", PrivacyMode.NO_STORAGE)
  const trimmed = value.trim()
  assert.ok(trimmed instanceof RedactedString)
  assert.equal(trimmed.__fieldName, "header")
  assert.equal(trimmed.__classification, DataClassification.CODE)
  assert.equal(trimmed.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "Token=abc")

  assert.equal(value.includes("Token"), true)
  assert.equal(value.indexOf("="), 7)
  assert.equal(value.startsWith("  "), true)
  assert.equal(value.toUpperCase().unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "  TOKEN=ABC  ")
  assert.equal(value.slice(2, 7).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "Token")
  assert.equal(value.replace("abc", "xyz").unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "  Token=xyz  ")
  assert.equal(value.at(-2)?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), " ")
  assert.equal(value.at(99), undefined)
  assert.equal(value.charAt(2).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "T")
  assert.deepEqual(
    value.split("=").map(part => part.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
    ["  Token", "abc  "],
  )

  const transformed = value.safeTransform(text => text.trim())
  assert.equal(transformed.__fieldName, "header", "a transform is not a new field")
  assert.equal(transformed.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "Token=abc")

  const clone = value.__clone("other")
  assert.equal(clone.__fieldName, "header.clone", "a clone marks itself as derived")
  assert.equal(value.__fieldName, "header", "and the original is untouched")
})

test("safeString is a value for things that were never secret", () => {
  const label = safeString("work.agent.list")
  assert.equal(label.__classification, DataClassification.SAFE)
  assert.equal(label.__isRedacted, false)
  assert.equal(label.unwrap(PrivacyCapability.STORAGE_FOR_LOGGING), "work.agent.list")
  assert.equal(`${label}`, "work.agent.list", "safe values print as themselves")
})

test("redacted bytes refuse, redact, or hand over the same way strings do", () => {
  const bytes = new Uint8Array([1, 2, 3])
  const value = createRedactedBytes(bytes, DataClassification.CODE, "attachment", PrivacyMode.NO_STORAGE)
  assert.ok(value instanceof RedactedBytes)
  assert.equal(value.length, 3)
  assert.equal(value.empty, false)

  assert.deepEqual(value.unwrap(PrivacyCapability.STORAGE_FOR_USAGE), bytes, "unenforced reads pass through")
  const enforced = createRedactedBytes(bytes, DataClassification.CREDENTIALS, "key", {
    privacyMode: PrivacyMode.NO_STORAGE,
    enforceRedaction: true,
  })
  assert.throws(() => enforced.unwrap(PrivacyCapability.STORAGE_FOR_LOGGING), /Unwrap not allowed/)
  assert.deepEqual(
    enforced.unwrap(PrivacyCapability.STORAGE_FOR_LOGGING, { redactUnallowedFieldsInsteadOfThrowing: true }),
    new Uint8Array(0),
  )
  assert.equal(enforced.__clone(new Uint8Array([9])).__fieldName, "key")
  assert.deepEqual(enforced.safeTransform(chunk => chunk.slice(0, 1)).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), new Uint8Array([1]))
})

test("the display value respects the enforcement decision", () => {
  const options = {
    privacyMode: PrivacyMode.NO_STORAGE,
    classification: DataClassification.CODE,
    fieldName: "user_text",
    unredactedValue: "secret",
  }
  assert.equal(getRedactionAwareDisplayValue(options), "secret", "no enforcement, no placeholder")
  assert.equal(getRedactionAwareDisplayValue({ ...options, enforceRedaction: true }), "[redacted:user_text]")
  assert.equal(
    getRedactionAwareDisplayValue({ ...options, classification: DataClassification.SAFE, enforceRedaction: true }),
    "secret",
  )
  assert.equal(
    getRedactionAwareDisplayValue({ ...options, enforceRedaction: false }),
    "secret",
    "an explicit opt-out wins over the gate",
  )
})

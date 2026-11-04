import { test } from "node:test"
import assert from "node:assert/strict"

import {
  brandLiteralEnum,
  brandedEnumOf,
  brandedErrno,
  brandedId,
  SLATE_ERRNO_FALLBACK,
  SLATE_ERRNO_TAGS,
} from "../../source/shared/errors/bounded-values.ts"
import {
  isRegisteredCode,
  SLATE_ERROR_DEFINITIONS,
  slateErrorTags,
  slateErrorWireCode,
  SlateError,
  UNREGISTERED_CODE,
  type SlateErrorCode,
} from "../../source/shared/errors/registry.ts"
import { errorLogTag, errorMessage } from "../../source/shared/errors/summary.ts"

test("errorMessage reports the message of an Error and the string form of anything else", () => {
  assert.equal(errorMessage(new Error("gateway refused")), "gateway refused")
  assert.equal(errorMessage(new TypeError("bad shape")), "bad shape")
  assert.equal(errorMessage("plain string"), "plain string")
  assert.equal(errorMessage(404), "404")
  assert.equal(errorMessage(undefined), "undefined")
  assert.equal(errorMessage({ code: "x" }), "[object Object]")
})

test("errorLogTag names the error and keeps its code when there is one", () => {
  assert.equal(errorLogTag(new Error("x")), "Error")
  assert.equal(errorLogTag(new TypeError("x")), "TypeError")

  const coded = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" })
  assert.equal(errorLogTag(coded), "Error (ECONNREFUSED)")

  const emptyCode = Object.assign(new Error("x"), { code: "" })
  assert.equal(errorLogTag(emptyCode), "Error", "an empty code is not a code")
  const numericCode = Object.assign(new Error("x"), { code: 42 })
  assert.equal(errorLogTag(numericCode), "Error", "only string codes are reported")

  assert.equal(errorLogTag("thrown string"), "string")
  assert.equal(errorLogTag(undefined), "undefined")
  assert.equal(errorLogTag(null), "object")
})

test("brandedEnumOf admits known values and folds the rest into the fallback", () => {
  const admit = brandedEnumOf(["alpha", "beta"] as const, "other")
  assert.equal(admit("alpha"), "alpha")
  assert.equal(admit("beta"), "beta")
  assert.equal(admit("gamma"), "other")
  assert.equal(admit(""), "other")
  assert.equal(admit(undefined), undefined, "an absent value stays absent")
})

test("brandLiteralEnum keeps the literal type it was given", () => {
  const value = brandLiteralEnum("transport")
  assert.equal(value, "transport")
})

test("brandedId admits opaque ids and refuses anything that could carry text", () => {
  assert.equal(brandedId("01HZ-abc_def.ghi:jkl|mno"), "01HZ-abc_def.ghi:jkl|mno")
  assert.equal(brandedId("a".repeat(128)), "a".repeat(128))
  assert.equal(brandedId("a".repeat(129)), undefined, "too long")
  assert.equal(brandedId(""), undefined, "empty")
  assert.equal(brandedId("has space"), undefined)
  assert.equal(brandedId("line\nbreak"), undefined)
  assert.equal(brandedId("line\n"), undefined, "an end anchor does not admit a trailing newline")
  assert.equal(brandedId("quote\"and'quote"), undefined)
  assert.equal(brandedId(undefined), undefined)
})

test("errno is reported from a known list, with one fallback for everything else", () => {
  assert.ok(SLATE_ERRNO_TAGS.includes("ECONNREFUSED"))
  assert.ok(SLATE_ERRNO_TAGS.includes("ENOSPC"))
  assert.equal(SLATE_ERRNO_TAGS.length, new Set(SLATE_ERRNO_TAGS).size, "no duplicates")

  assert.equal(brandedErrno("ECONNREFUSED"), "ECONNREFUSED")
  assert.equal(brandedErrno("ETOOMANYREFS"), SLATE_ERRNO_FALLBACK)
  assert.equal(brandedErrno("econnrefused"), SLATE_ERRNO_FALLBACK, "matching is exact")
  assert.equal(brandedErrno(undefined), undefined)
})

test("every registered condition has a constructor that stamps its own code", () => {
  const seen = new Set<string>()
  for (const [code, definition] of Object.entries(SLATE_ERROR_DEFINITIONS) as [SlateErrorCode, { name: string }][]) {
    assert.ok(!seen.has(definition.name), `duplicate name ${definition.name}`)
    seen.add(definition.name)

    const construct = (SlateError as Record<string, (payload?: Record<string, unknown>) => { code: string }>)[definition.name]
    assert.equal(typeof construct, "function", `${definition.name} is constructible`)
    assert.equal(construct?.()?.code, code, `${definition.name} stamps ${code}`)
  }
})

test("a catalogue entry only declares payload fields it can tag", () => {
  const identifier = /^[a-z][A-Za-z0-9]*$/
  for (const [code, definition] of Object.entries(SLATE_ERROR_DEFINITIONS)) {
    assert.match(code, /^SLATE-E\d{4}$/, `${code} keeps the code shape`)
    assert.ok(definition.summary.length > 0, `${code} explains itself`)
    assert.ok(definition.raisedBy.length > 0, `${code} says where it is raised`)
    assert.ok(["registry", "transport", "auth", "rebuild", "agent", "storage"].includes(definition.domain), `${code} domain`)
    assert.equal(typeof definition.retryable, "boolean")
    for (const field of definition.payload) {
      assert.match(field, identifier, `${code} payload field ${field}`)
      assert.ok((field as string) !== "code", `${code} does not redeclare the code`)
    }
  }
})

test("payload travels as bounded, declared tags under snake_case keys", () => {
  const error = SlateError.gatewayTimeout({ errno: "ECONNREFUSED", attempt: 3, secret: "not declared" })
  assert.deepEqual(slateErrorTags(error), {
    error_code: "SLATE-E0102",
    error_domain: "transport",
    error_retryable: "true",
    errno: "ECONNREFUSED",
  })

  const numeric = SlateError.gatewayHttp5xx({ httpStatus: 503 })
  assert.equal(slateErrorTags(numeric)["http_status"], "503", "camelCase becomes snake_case")
})

test("a declared payload field is dropped when its value cannot be bounded", () => {
  const long = "x".repeat(65)
  assert.deepEqual(slateErrorTags(SlateError.gatewayTimeout({ errno: long })), {
    error_code: "SLATE-E0102",
    error_domain: "transport",
    error_retryable: "true",
  })
  assert.equal(slateErrorTags(SlateError.gatewayTimeout({ errno: "" })).errno, undefined, "empty is dropped")
  assert.equal(
    slateErrorTags(SlateError.gatewayTimeout({ errno: "carries a space" })).errno,
    undefined,
    "free text is dropped",
  )
  assert.equal(slateErrorTags(SlateError.gatewayTimeout({ errno: undefined })).errno, undefined)
  assert.equal(
    slateErrorTags(SlateError.gatewayTimeout({ errno: Number.NaN })).errno,
    undefined,
    "a non-finite number is not a value",
  )
})

test("an unregistered code is reclassified and ships no payload", () => {
  const foreign = { code: "SOME-OTHER-CODE", errno: "ECONNREFUSED", detail: "should never leave" }
  assert.equal(isRegisteredCode(foreign.code), false)
  assert.equal(slateErrorWireCode(foreign), UNREGISTERED_CODE)
  assert.deepEqual(slateErrorTags(foreign), {
    error_code: UNREGISTERED_CODE,
    error_domain: "registry",
    error_retryable: "false",
  })

  assert.equal(isRegisteredCode(UNREGISTERED_CODE), true)
  assert.equal(isRegisteredCode(undefined), false)
  assert.equal(isRegisteredCode(42), false)
  assert.equal(slateErrorWireCode({}), UNREGISTERED_CODE)
})

test("retryability is part of the reported tags", () => {
  assert.equal(slateErrorTags(SlateError.gatewayTimeout()).error_retryable, "true")
  assert.equal(slateErrorTags(SlateError.contextWindowOverflow()).error_retryable, "false")
  assert.equal(slateErrorTags(SlateError.webauthnConsentDeclined()).error_retryable, "false")
})

test("the registered codes cover the platform's domains", () => {
  const domains = new Set(Object.values(SLATE_ERROR_DEFINITIONS).map(definition => definition.domain))
  assert.deepEqual([...domains].sort(), ["agent", "auth", "rebuild", "registry", "storage", "transport"])
  assert.equal(Object.keys(SLATE_ERROR_DEFINITIONS).length, 51)
})

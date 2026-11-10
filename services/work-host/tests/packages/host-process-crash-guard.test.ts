import { test } from "node:test"
import assert from "node:assert/strict"

import { handleProcessCrash, installProcessCrashGuards, toError } from "../../source/host/process-crash-guard.ts"

/** Run a crash scenario with the console and the process's listeners captured, and restore both afterwards. */
const withCapturedProcess = (run: (captured: { logged: unknown[][]; registrations: Array<[string, (value: unknown) => void]> }) => void): void => {
  const originalConsoleError = console.error
  const originalOn = process.on
  const logged: unknown[][] = []
  const registrations: Array<[string, (value: unknown) => void]> = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  process.on = ((event: string, listener: (value: unknown) => void) => {
    registrations.push([event, listener])
    return process
  }) as typeof process.on
  try {
    run({ logged, registrations })
  } finally {
    console.error = originalConsoleError
    process.on = originalOn
  }
}

test("a thrown value becomes the error behind it", () => {
  const error = new Error("boom")
  assert.equal(toError(error), error, "an error is itself")
  assert.equal(toError("text").message, "text")
  assert.equal(toError(7).message, "7")
  assert.equal(toError(null).message, "null")
  assert.equal(toError(undefined).message, "undefined")
  assert.equal(toError({ toString: () => "custom" }).message, "custom")
  assert.equal(toError(Symbol("s")).message, "Symbol(s)")
  assert.equal(toError(10n).message, "10")
})

test("a crash is logged under its scope and reported without being allowed to throw further", () => {
  withCapturedProcess(({ logged }) => {
    const calls: Array<[string, string]> = []
    handleProcessCrash({ scope: "slate-host", onError: (error, kind) => calls.push([error.message, kind]) }, "uncaughtException", new Error("boom"))
    assert.deepEqual(logged, [["[slate-host] uncaughtException (kept alive):", new Error("boom")]])
    assert.deepEqual(calls, [["boom", "uncaughtException"]])

    logged.length = 0
    handleProcessCrash({ scope: "s" }, "unhandledRejection", "reason")
    assert.equal(logged.length, 1)
    assert.deepEqual(logged[0]?.[0], "[s] unhandledRejection (kept alive):")
    assert.equal((logged[0]?.[1] as Error).message, "reason")

    assert.doesNotThrow(() => handleProcessCrash({ scope: "s", onError: () => { throw new Error("reporter broke") } }, "uncaughtException", 7), "a reporter that throws does not become the crash")
    assert.doesNotThrow(() => handleProcessCrash({ scope: "s", onError: 7 as never }, "uncaughtException", 7), "a reporter that is not a function is not a crash either")
  })
})

test("the guards listen for both kinds and let the reporter be replaced afterwards", () => {
  withCapturedProcess(({ registrations }) => {
    const calls: Array<[string, string]> = []
    const guards = installProcessCrashGuards({ scope: "slate-host", onError: (error, kind) => calls.push([error.message, kind]) })
    assert.deepEqual(registrations.map(([event]) => event), ["uncaughtException", "unhandledRejection"], "one listener per crash kind, in that order")
    assert.deepEqual(Object.keys(guards), ["setReporter"])
    assert.equal(guards.setReporter.name, "setReporter")

    registrations[0]?.[1](new Error("first"))
    registrations[1]?.[1]("rejected reason")
    assert.deepEqual(calls, [["first", "uncaughtException"], ["rejected reason", "unhandledRejection"]])

    guards.setReporter(undefined)
    registrations[0]?.[1](new Error("after clearing"))
    assert.equal(calls.length, 2, "a cleared reporter is not called")

    guards.setReporter((error, kind) => calls.push(["later", kind]))
    registrations[1]?.[1](new Error("later"))
    assert.deepEqual(calls[2], ["later", "unhandledRejection"], "the replacement reporter is called from then on")

    guards.setReporter(7 as never)
    assert.doesNotThrow(() => registrations[0]?.[1](new Error("x")), "a reporter that is not a function does not crash the guard")
  })
})

test("the guards log under the scope they were given when the crash happens", () => {
  withCapturedProcess(({ logged, registrations }) => {
    const options = { scope: "before" }
    const guards = installProcessCrashGuards(options)
    options.scope = "after"
    registrations[registrations.length - 2]?.[1](new Error("scope"))
    assert.deepEqual(logged[0]?.[0], "[after] uncaughtException (kept alive):", "the scope is read when the crash is reported")
    guards.setReporter(undefined)
  })
})

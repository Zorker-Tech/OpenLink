import assert from "node:assert/strict"
import test from "node:test"

import {
  createCoordinatorCrashHandler,
  createCoordinatorStopHandler,
  observeCoordinatorPort,
} from "../../source/coordinator/main-lifecycle.ts"

const tick = () => new Promise(resolve => setImmediate(resolve))

test("process shutdown releases resources once and leaves carrier exit last", () => {
  const actions: string[] = []
  const stop = createCoordinatorStopHandler({
    closeGateway: () => actions.push("gateway"),
    clearToolRelay: () => actions.push("relay"),
    disposeLocalExec: () => actions.push("local-exec"),
    disposeOAuthForwarder: () => actions.push("oauth"),
    stopControlPort: () => actions.push("control-client"),
    closeRendererPort: () => actions.push("renderer-port"),
    closeMainPort: () => actions.push("main-port"),
    closeCarrierControl: () => actions.push("carrier-control"),
    closeCarrierData: () => actions.push("carrier-data"),
    closeCarrierMainData: () => actions.push("carrier-main-data"),
    exitProcess: code => actions.push(`exit:${code}`),
  })

  stop(0)
  stop(1)

  assert.deepEqual(actions, [
    "gateway", "relay", "local-exec", "oauth", "control-client", "renderer-port", "main-port",
    "carrier-control", "carrier-data", "carrier-main-data", "exit:0",
  ])
})

test("a protocol breach reports its owning surface and turns shutdown into failure", async () => {
  const reports: string[] = []
  const exits: number[] = []
  observeCoordinatorPort(Promise.resolve({ outcome: "protocol-breach", detail: "invalid envelope" }), {
    prefix: "coordinator: ",
    breachLabel: "renderer protocol breach",
    report: message => reports.push(message),
    stop: code => exits.push(code),
  })
  await tick()

  assert.deepEqual(reports, ["coordinator: renderer protocol breach: invalid envelope\n"])
  assert.deepEqual(exits, [1])
})

test("unexpected process errors are reported before failure exit; an undelivered report is logged", async () => {
  const reports: string[] = []
  const requests: unknown[] = []
  const exits: number[] = []
  const onCrash = createCoordinatorCrashHandler({
    prefix: "coordinator: ",
    report: message => reports.push(message),
    submitReport: async value => { requests.push(value); throw new Error("control port closed") },
    stop: code => exits.push(code),
  })
  const failure = new Error("worker broke")
  onCrash("uncaughtException", failure)
  await tick()

  assert.deepEqual(requests, [{
    kind: "uncaughtException",
    errorName: "Error",
    errorMessage: "worker broke",
    errorStack: failure.stack,
  }])
  assert.match(reports[0] ?? "", /^coordinator: uncaughtException: Error: worker broke/)
  assert.deepEqual(reports.slice(1), ["coordinator: crash report undelivered: Error: control port closed\n"])
  assert.deepEqual(exits, [1])
})

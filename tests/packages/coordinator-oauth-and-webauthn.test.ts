import { test } from "node:test"
import assert from "node:assert/strict"

import { startMcpOAuthCallbackListener } from "../../source/coordinator/oauth/mcp-oauth-callback-listener.ts"
import { createWebAuthnProvider } from "../../source/coordinator/webauthn/provider.ts"

// ---------------------------------------------------------------------------------------------
// Waiting for an OAuth flow to come back
// ---------------------------------------------------------------------------------------------

function createRegistry() {
  let handler: ((requestUrl: URL, request: unknown, response: unknown) => Promise<boolean>) | undefined
  let released = 0
  const responses: ReturnType<typeof createResponse>[] = []
  const registry = {
    acquire: async (_redirectUrl: URL, next: (requestUrl: URL, request: unknown, response: unknown) => Promise<boolean>) => {
      handler = next
      return () => {
        released += 1
      }
    },
  }
  return {
    registry,
    responses,
    invoke: (url: string) => {
      const response = createResponse()
      responses.push(response)
      return handler!(new URL(url), {}, response)
    },
    released: () => released,
  }
}

function createResponse() {
  const writes: string[] = []
  let status = 0
  return {
    writes,
    get status() {
      return status
    },
    writeHead(code: number) {
      status = code
    },
    end(body?: string) {
      if (body !== undefined) writes.push(body)
    },
  }
}

test("the callback the flow makes is answered, and only the flow's own callback", async () => {
  const callbacks: Array<{ code: string; state: string }> = []
  const { registry, invoke, released } = createRegistry()
  const settled: string[] = []
  const listener = await startMcpOAuthCallbackListener({
    redirectUrl: "http://127.0.0.1:41234/callback",
    resolve: (state: string) => (state === "state-1" ? { serverName: "mine" } : undefined),
    onCallback: async (result: { code: string; state: string }) => {
      callbacks.push(result)
    },
    onSettled: (state: string) => {
      settled.push(state)
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as never, registry as never)

  // Another path on the same address is not this flow's callback.
  assert.equal(await invoke("http://127.0.0.1:41234/other"), false)
  assert.equal(callbacks.length, 0)

  // The flow's own callback with the state it was started with is answered.
  assert.equal(await invoke("http://127.0.0.1:41234/callback?code=abc&state=state-1"), true)
  assert.deepEqual(callbacks, [{ code: "abc", state: "state-1" }])

  // The listener stops when the flow is done.
  assert.deepEqual(settled, ["state-1"])
  listener.close()
  assert.equal(released(), 1)
})

test("a callback that is not the flow's own is refused rather than answered", async () => {
  const callbacks: unknown[] = []
  const { registry, invoke } = createRegistry()
  await startMcpOAuthCallbackListener({
    redirectUrl: "http://127.0.0.1:41234/callback",
    resolve: (state: string) => (state === "state-1" ? { serverName: "mine" } : undefined),
    onCallback: async (result: { code: string; state: string }) => {
      callbacks.push(result)
    },
    onSettled: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as never, registry as never)

  // A state that is not the one the flow was started with is somebody else's callback.
  assert.equal(await invoke("http://127.0.0.1:41234/callback?code=abc&state=state-2"), false)
  // So is a callback with no state at all.
  assert.equal(await invoke("http://127.0.0.1:41234/callback?code=abc"), false)
  assert.equal(callbacks.length, 0)
})

test("OAuth denial, missing code and completion failure settle with the expected response status", async () => {
  const { registry, invoke, responses } = createRegistry()
  const callbackResults: Array<{ code: string; state: string }> = []
  const settled: string[] = []
  const warnings: unknown[] = []
  await startMcpOAuthCallbackListener({
    redirectUrl: "http://127.0.0.1:41234/callback",
    resolve: (state: string) => ({ serverName: state }),
    onCallback: async (result: { code: string; state: string }) => {
      if (result.code === "broken") throw new Error("completion failed")
      callbackResults.push(result)
    },
    onSettled: (state: string) => settled.push(state),
    log: { info: () => {}, warn: (event: unknown) => warnings.push(event), error: () => {} },
  } as never, registry as never)

  assert.equal(await invoke("http://127.0.0.1:41234/callback?state=denied&error=access_denied"), true)
  assert.equal(await invoke("http://127.0.0.1:41234/callback?state=missing-code"), true)
  assert.equal(await invoke("http://127.0.0.1:41234/callback?state=failed&code=broken"), true)
  assert.deepEqual(responses.map((response) => response.status), [400, 400, 500])
  assert.deepEqual(callbackResults, [])
  assert.deepEqual(settled, ["denied", "missing-code", "failed"])
  assert.equal(warnings.length, 1)
});

// ---------------------------------------------------------------------------------------------
// Asking the user to touch their key
// ---------------------------------------------------------------------------------------------

test("the provider is started and stopped, and asks nothing until a ceremony arrives", async () => {
  let consentAsked = 0
  const logs: string[] = []
  const provider = createWebAuthnProvider({
    resolveConnection: async () => ({ baseUrl: "http://127.0.0.1:1" }),
    signer: {} as never,
    heartbeatPolicy: { start: () => ({ dispose: () => {} }) },
    reconnectPolicy: { runWithRetry: async () => undefined } as never,
    consent: {
      requestConsent: async () => {
        consentAsked += 1
        return { approved: false }
      },
      finish: () => {},
    },
    log: (message: string) => logs.push(message),
  } as never)

  // Starting twice and stopping twice are both safe: the provider keeps one lifetime.
  provider.start()
  provider.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  provider.stop()
  provider.stop()

  // Nobody was asked for consent, since no ceremony was ever requested.
  assert.equal(consentAsked, 0)
})

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  attachSearchIndexWorker,
  type SearchIndexWorkerPort,
  type SearchIndexWorkerRequest,
  type SearchIndexWorkerResponse,
} from "../../source/host/extensions/content-search/search-index-worker.ts"

function workerPort() {
  let listener: ((request: SearchIndexWorkerRequest) => void) | undefined
  const messages: SearchIndexWorkerResponse[] = []
  const port: SearchIndexWorkerPort = {
    on(event, handler) {
      assert.equal(event, "message")
      listener = handler
    },
    postMessage(message) {
      messages.push(message)
    },
  }
  return {
    messages,
    port,
    send(request: SearchIndexWorkerRequest) {
      assert.ok(listener)
      listener(request)
    },
  }
}

test("a completed index job returns a success response with its request id", () => {
  const calls: unknown[] = []
  const channel = workerPort()
  attachSearchIndexWorker(channel.port, { runJob: job => calls.push(job) })
  const request = { requestId: 17, job: { kind: "clear-agent", agentId: "agent-a" } } as const

  channel.send(request)

  assert.deepEqual(calls, [request.job])
  assert.deepEqual(channel.messages, [{ requestId: 17, ok: true }])
})

test("a job failure returns its message and marks database corruption", () => {
  const channel = workerPort()
  attachSearchIndexWorker(channel.port, {
    runJob() {
      throw new Error("database disk image is malformed")
    },
  })

  channel.send({ requestId: 21, job: { kind: "reconcile" } })

  assert.deepEqual(channel.messages, [{
    requestId: 21,
    ok: false,
    message: "database disk image is malformed",
    isIndexCorrupt: true,
  }])
})

test("ordinary errors are reported without the corruption flag", () => {
  const channel = workerPort()
  attachSearchIndexWorker(channel.port, {
    runJob() {
      throw "write failed"
    },
  })

  channel.send({ requestId: 22, job: { kind: "reconcile" } })

  assert.deepEqual(channel.messages, [{
    requestId: 22,
    ok: false,
    message: "write failed",
    isIndexCorrupt: false,
  }])
})

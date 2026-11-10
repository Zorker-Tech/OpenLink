import assert from "node:assert/strict"
import { test } from "node:test"

import { probeAgentStoreObject } from "../../source/packages/agent-store-sync/object-probe.ts"

const STORE_URL = "https://agent-stores.s3.us-east-1.amazonaws.com/objects/notes.txt?signature=private"

function response(status: number, etag?: string) {
  let cancellations = 0
  return {
    value: {
      status,
      headers: { get(name: string) { return name.toLowerCase() === "etag" ? etag ?? null : null } },
      body: { async cancel() { cancellations += 1 } },
    },
    cancellations: () => cancellations,
  }
}

function probeFixture(options: {
  readonly responses?: ReturnType<typeof response>[]
  readonly presigned?: readonly { readonly relPath: string; readonly url: string }[]
  readonly requestedPath?: string
  readonly signal?: AbortSignal
  readonly url?: string
  readonly validate?: (url: URL) => void
}) {
  const presignRequests: unknown[] = []
  const fetchRequests: Array<{
    readonly url: string
    readonly options: {
      readonly redirect: "error"
      readonly signal?: AbortSignal
      readonly headers?: { readonly Range: "bytes=0-0" }
    }
  }> = []
  const validatedUrls: string[] = []
  const order: string[] = []
  const pending = [...(options.responses ?? [response(206, '"AbC"')])]
  const presigned = options.presigned ?? [{ relPath: "notes/file.txt", url: options.url ?? STORE_URL }]

  const run = () => probeAgentStoreObject({
    client: {
      async presignReads(args) {
        presignRequests.push(args)
        return presigned
      },
    },
    agentId: "agent-7",
    relPath: options.requestedPath ?? "notes/file.txt",
    fetchImpl: async (url, fetchOptions) => {
      fetchRequests.push({ url, options: fetchOptions })
      const next = pending.shift()
      if (next === undefined) throw new Error("unexpected fetch")
      return next.value
    },
    validatePresignedUrl: (url) => {
      validatedUrls.push(url.href)
      options.validate?.(url)
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    runPresign: async <T>(runPresignCall: () => Promise<T>) => {
      order.push("presign")
      return await runPresignCall()
    },
    runS3: async <T>(runStoreCall: () => Promise<T>) => {
      order.push("store")
      return await runStoreCall()
    },
  })

  return { run, presignRequests, fetchRequests, validatedUrls, order, responses: options.responses ?? [] }
}

test("an object probe sends a one-byte range and returns the normalized entity tag", async () => {
  const signal = new AbortController().signal
  const ok = response(206, '"AbC"')
  const fixture = probeFixture({ responses: [ok], signal, presigned: [{ relPath: "notes\\file.txt", url: STORE_URL }] })

  assert.deepEqual(await fixture.run(), { kind: "exists", etag: "abc" })
  assert.deepEqual(fixture.presignRequests, [{ agentId: "agent-7", relPaths: ["notes/file.txt"], signal }])
  assert.equal(fixture.fetchRequests[0]?.url, STORE_URL)
  assert.equal(fixture.fetchRequests[0]?.options.redirect, "error")
  assert.equal(fixture.fetchRequests[0]?.options.signal, signal)
  assert.equal(fixture.fetchRequests[0]?.options.headers?.Range, "bytes=0-0")
  assert.deepEqual(fixture.validatedUrls, [STORE_URL])
  assert.deepEqual(fixture.order, ["presign", "store"])
  assert.equal(ok.cancellations(), 1)
})

test("a missing object is absent and its response body is closed", async () => {
  const missing = response(404)
  const fixture = probeFixture({ responses: [missing] })

  assert.deepEqual(await fixture.run(), { kind: "absent" })
  assert.equal(missing.cancellations(), 1)
})

test("an empty-object range refusal retries without a range", async () => {
  const rejectedRange = response(416)
  const emptyObject = response(200, '"empty-tag"')
  const fixture = probeFixture({ responses: [rejectedRange, emptyObject] })

  assert.deepEqual(await fixture.run(), { kind: "exists", etag: "empty-tag" })
  assert.equal(fixture.fetchRequests.length, 2)
  assert.equal(fixture.fetchRequests[0]?.options.headers?.Range, "bytes=0-0")
  assert.equal(fixture.fetchRequests[1]?.options.headers, undefined)
  assert.deepEqual(fixture.order, ["presign", "store", "store"])
  assert.equal(rejectedRange.cancellations(), 1)
  assert.equal(emptyObject.cancellations(), 1)
})

test("a path mismatch, a missing presign and an unsafe URL stop before fetch", async () => {
  const mismatch = probeFixture({ presigned: [{ relPath: "notes/other.txt", url: STORE_URL }] })
  await assert.rejects(mismatch.run(), /relPath mismatch/)
  assert.equal(mismatch.fetchRequests.length, 0)

  const noRead = probeFixture({ presigned: [] })
  await assert.rejects(noRead.run(), /returned no read/)
  assert.equal(noRead.fetchRequests.length, 0)

  const rejectedUrl = probeFixture({ validate: () => { throw new Error("host not allowed") } })
  await assert.rejects(rejectedUrl.run(), /Refusing presigned URL.*host not allowed/)
  assert.equal(rejectedUrl.fetchRequests.length, 0)
})

test("failed store responses and unusable tags fail after closing their bodies", async () => {
  const forbidden = response(403)
  const failedStatus = probeFixture({ responses: [forbidden] })
  await assert.rejects(failedStatus.run(), /probe failed.*403/)
  assert.equal(forbidden.cancellations(), 1)

  const noTag = response(200)
  const missingTag = probeFixture({ responses: [noTag] })
  await assert.rejects(missingTag.run(), /no usable etag/)
  assert.equal(noTag.cancellations(), 1)
})

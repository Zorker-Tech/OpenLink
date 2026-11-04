import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createUaOwnerStampWriter,
  UA_OWNER_STAMP_LENGTH,
  uaOwnerStampForAccessToken,
} from "../../source/host/extensions/browser-ua/ua-owner-stamp-service.ts"

function accessToken(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "slate-ua-owner-stamp-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("a subject becomes a fixed-length digest, while absent subjects have no stamp", () => {
  const token = accessToken({ sub: "user-17" })
  const expected = createHash("sha256").update("user-17", "utf8").digest("hex").slice(0, UA_OWNER_STAMP_LENGTH)

  assert.equal(uaOwnerStampForAccessToken(token), expected)
  assert.equal(expected.length, UA_OWNER_STAMP_LENGTH)
  assert.equal(uaOwnerStampForAccessToken(accessToken({})), null)
  assert.equal(uaOwnerStampForAccessToken(accessToken({ sub: "" })), null)
  assert.equal(uaOwnerStampForAccessToken("not-a-token"), null)
})

test("the writer ignores missing tokens, persists changes atomically and skips the same owner", async () => {
  await withDirectory(async directory => {
    const path = join(directory, "owner")
    const logs: string[] = []
    const write = createUaOwnerStampWriter({ path, log: message => logs.push(message) })
    const firstToken = accessToken({ sub: "first" })
    const firstStamp = uaOwnerStampForAccessToken(firstToken)

    await write(null)
    assert.equal(await readFile(path).catch(() => null), null)
    await write(firstToken)
    assert.equal(await readFile(path, "utf8"), `${firstStamp}\n`)
    await assert.rejects(stat(`${path}.tmp`), { code: "ENOENT" })

    await writeFile(path, "changed outside\n")
    await write(firstToken)
    assert.equal(await readFile(path, "utf8"), "changed outside\n")

    const secondToken = accessToken({ sub: "second" })
    await write(secondToken)
    assert.equal(await readFile(path, "utf8"), `${uaOwnerStampForAccessToken(secondToken)}\n`)
    assert.deepEqual(logs, [])
  })
})

test("a failed write is logged and the same owner can be retried later", async () => {
  await withDirectory(async directory => {
    const path = join(directory, "missing", "owner")
    const logs: string[] = []
    const write = createUaOwnerStampWriter({ path, log: message => logs.push(message) })
    const token = accessToken({ sub: "retry-me" })

    await write(token)
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /ua-owner stamp write failed/)

    await mkdir(join(directory, "missing"))
    await write(token)
    assert.equal(await readFile(path, "utf8"), `${uaOwnerStampForAccessToken(token)}\n`)
  })
})

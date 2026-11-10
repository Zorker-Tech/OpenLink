import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildOriginTokenGitConfig,
  ORIGIN_GIT_HOSTS,
  PREFER_ORIGIN_READS_HEADER,
} from "../../source/adapters/interop/git/origin-auth-config-adapter.ts"

describe("origin token Git config interop", () => {
  it("does not emit authentication settings without a nonempty token", () => {
    assert.equal(buildOriginTokenGitConfig(undefined, ["origin.example"]), undefined)
    assert.equal(buildOriginTokenGitConfig("", ["origin.example"]), undefined)
  })

  it("builds one authorization entry per supplied host with stable deduplication", () => {
    const token = "origin-token"
    const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    const config = buildOriginTokenGitConfig(token, [" ", "origin.example", "origin.example", "mirror.example"])

    assert.deepEqual(ORIGIN_GIT_HOSTS, [])
    assert.deepEqual(config, {
      "http.https://origin.example/.extraheader": [auth, PREFER_ORIGIN_READS_HEADER],
      "http.https://mirror.example/.extraheader": [auth, PREFER_ORIGIN_READS_HEADER],
    })
    assert.deepEqual(buildOriginTokenGitConfig(token), {})
  })
})

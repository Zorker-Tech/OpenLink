import assert from "node:assert/strict"
import { test } from "node:test"

import { isOriginGitHost } from "../../source/packages/utils/repo-url.ts"

test("no Git host is treated as the platform's own plugin origin without an origin policy", () => {
  for (const host of ["git.example", "codehost.internal", "forge.test"]) {
    assert.equal(isOriginGitHost(host), false, host)
  }
})

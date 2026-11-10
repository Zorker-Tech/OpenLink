import assert from "node:assert/strict"
import test from "node:test"

import { appendRandomUploadSuffix } from "../../source/packages/agent/context/attachment-filenames.ts"

test("upload names are safe, unique and keep suffixes before normal extensions", () => {
  const one = appendRandomUploadSuffix("report.pdf", "fallback")
  const two = appendRandomUploadSuffix("report.pdf", "fallback")
  assert.match(one, /^report_[a-zA-Z0-9]{4}\.pdf$/)
  assert.notEqual(one, two)
  assert.match(appendRandomUploadSuffix("no extension", "fallback"), /^no_extension_[a-zA-Z0-9]{4}$/)
  assert.match(appendRandomUploadSuffix("a/b:c", "fallback"), /^a_b_c_[a-zA-Z0-9]{4}$/)
})

test("fallback names and dotfiles use the same suffix placement rule", () => {
  assert.match(appendRandomUploadSuffix("", "fallback.txt"), /^fallback_[a-zA-Z0-9]{4}\.txt$/)
  assert.match(appendRandomUploadSuffix(".profile", "fallback"), /^\.profile_[a-zA-Z0-9]{4}$/)
})

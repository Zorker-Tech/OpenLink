import assert from "node:assert/strict"
import test from "node:test"
import {
  appendEntry,
  clearTranscript,
  getTranscript,
  removeEntry,
  setTranscript,
  updateEntry,
} from "../../source/host/transcript/transcript-store.ts"

const entry = (id: string, content: string) => ({ id, kind: "message", content })

test("setting a transcript copies the input list and reads the stored list", () => {
  clearTranscript()
  const input = [entry("one", "first")]

  setTranscript(input)
  input.push(entry("two", "outside"))

  assert.deepEqual(getTranscript(), [entry("one", "first")])
})

test("append replaces the stored list while retaining the entries already held", () => {
  clearTranscript()
  setTranscript([entry("one", "first")])
  const previousView = getTranscript()

  appendEntry(entry("two", "second"))

  assert.deepEqual(previousView, [entry("one", "first")])
  assert.deepEqual(getTranscript(), [entry("one", "first"), entry("two", "second")])
})

test("updates visit each matching id and return the last replacement", () => {
  clearTranscript()
  setTranscript([entry("duplicate", "first"), entry("other", "keep"), entry("duplicate", "second")])
  const changed = updateEntry("duplicate", current => ({ ...current, content: `${current.content}-updated` }))

  assert.deepEqual(changed, entry("duplicate", "second-updated"))
  assert.deepEqual(getTranscript(), [
    entry("duplicate", "first-updated"),
    entry("other", "keep"),
    entry("duplicate", "second-updated"),
  ])
  assert.equal(updateEntry("missing", current => current), null)
})

test("removal deletes every matching id and reports whether anything changed", () => {
  clearTranscript()
  setTranscript([entry("duplicate", "one"), entry("other", "keep"), entry("duplicate", "two")])

  assert.equal(removeEntry("duplicate"), true)
  assert.deepEqual(getTranscript(), [entry("other", "keep")])
  assert.equal(removeEntry("duplicate"), false)
})

test("clearing replaces the stored list with an empty transcript", () => {
  setTranscript([entry("one", "first")])
  clearTranscript()

  assert.deepEqual(getTranscript(), [])
})

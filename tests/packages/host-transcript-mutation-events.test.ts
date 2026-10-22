import { test } from "node:test"
import assert from "node:assert/strict"

import { publishTranscriptMutation, subscribeTranscriptMutations } from "../../source/host/transcript/transcript-mutation-events.ts"

test("a listener is told about changes in the order it started listening, and stops when it unsubscribes", () => {
  const seen: Array<[string, string]> = []
  const unsubscribeFirst = subscribeTranscriptMutations((mutation) => seen.push(["first", mutation.kind]))
  const unsubscribeSecond = subscribeTranscriptMutations((mutation) => seen.push(["second", mutation.kind]))
  try {
    const mutation = { kind: "insert", n: 1 }
    publishTranscriptMutation(mutation)
    assert.deepEqual(seen, [["first", "insert"], ["second", "insert"]])

    unsubscribeFirst()
    publishTranscriptMutation({ kind: "after" })
    assert.deepEqual(seen.slice(2), [["second", "after"]])
  } finally {
    unsubscribeFirst()
    unsubscribeSecond()
  }
})

test("a listener that fails does not keep the others from being told", () => {
  const seen: string[] = []
  const unsubscribeThrowing = subscribeTranscriptMutations(() => { throw new Error("listener broke") })
  const unsubscribeQuiet = subscribeTranscriptMutations((mutation) => seen.push(mutation.kind))
  try {
    assert.doesNotThrow(() => publishTranscriptMutation({ kind: "with-throw" }))
    assert.deepEqual(seen, ["with-throw"])

    const unsubscribeNotAFunction = subscribeTranscriptMutations(7 as never)
    try {
      assert.doesNotThrow(() => publishTranscriptMutation({ kind: "non-function" }), "a listener that is not a function is swallowed too")
    } finally {
      unsubscribeNotAFunction()
    }
  } finally {
    unsubscribeThrowing()
    unsubscribeQuiet()
  }
})

test("the same listener subscribed twice is told once, and one unsubscribe stops it", () => {
  const seen: string[] = []
  const listener = (mutation: { kind: string }) => seen.push(mutation.kind)
  const unsubscribeFirst = subscribeTranscriptMutations(listener)
  const unsubscribeSecond = subscribeTranscriptMutations(listener)
  try {
    publishTranscriptMutation({ kind: "duplicate" })
    assert.deepEqual(seen, ["duplicate"], "a set holds one subscription per listener")
    unsubscribeFirst()
    publishTranscriptMutation({ kind: "after-one-unsubscribe" })
    assert.deepEqual(seen, ["duplicate"], "the second unsubscribe is what would have kept it")
    unsubscribeSecond()
    publishTranscriptMutation({ kind: "after-both" })
    assert.deepEqual(seen, ["duplicate"])
  } finally {
    unsubscribeFirst()
    unsubscribeSecond()
  }
})

test("a change told to a set that is being changed is told to whoever is in it at the time", () => {
  const seen: string[] = []
  let unsubscribeSelf: () => void = () => {}
  const self = (mutation: { kind: string }) => {
    seen.push("self:" + mutation.kind)
    unsubscribeSelf()
  }
  unsubscribeSelf = subscribeTranscriptMutations(self)
  let unsubscribeLate: (() => void) | undefined
  const unsubscribeHost = subscribeTranscriptMutations((mutation) => {
    seen.push("host:" + mutation.kind)
    if (mutation.kind === "add-late") unsubscribeLate = subscribeTranscriptMutations((late) => seen.push("late:" + late.kind))
  })
  const unsubscribeTail = subscribeTranscriptMutations((mutation) => seen.push("tail:" + mutation.kind))
  try {
    publishTranscriptMutation({ kind: "add-late" })
    assert.deepEqual(seen, ["self:add-late", "host:add-late", "tail:add-late", "late:add-late"], "a listener added during the publish is told in that same publish")
    seen.length = 0
    publishTranscriptMutation({ kind: "next" })
    assert.deepEqual(seen, ["host:next", "tail:next", "late:next"], "the listener that unsubscribed itself is not told again")
  } finally {
    unsubscribeHost()
    unsubscribeTail()
    unsubscribeLate?.()
    unsubscribeSelf()
  }
})

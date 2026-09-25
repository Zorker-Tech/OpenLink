import { test } from "node:test"
import assert from "node:assert/strict"

import { formatTranscriptLocation } from "../../source/packages/agent-summarization/transcript-location.ts"

const FOLDER = "/repo/.slate/projects/workspace-1/agent-transcripts"

test("a conversation with an id is told exactly where its transcript is", () => {
  const text = formatTranscriptLocation(FOLDER, { conversationId: "conversation-1" })
  assert.match(text, /### Transcript location:/)
  assert.match(text, new RegExp(`${FOLDER}/conversation-1/conversation-1\\.jsonl`))
  // The folder is not named on its own, since the file inside it is what the model should open.
  assert.equal(text.includes(`past conversations with the user (pre- and post-summary): ${FOLDER}\n`), false)
})

test("a conversation with no id is told the folder and how it is laid out", () => {
  const text = formatTranscriptLocation(FOLDER)
  assert.match(text, new RegExp(`full transcripts of past conversations with the user \\(pre- and post-summary\\): ${FOLDER}`))
  assert.match(text, /Each conversation is stored as a <convoId>\/<convoId>\.jsonl/)
})

test("the model is told how to use the transcript rather than read it", () => {
  const text = formatTranscriptLocation(FOLDER, { conversationId: "conversation-1" })
  assert.match(text, /Search first for relevant keywords/)
  assert.match(text, /Avoid reading linearly end-to-end/)
  assert.match(text, /tool calls and results are excluded/)
})

test("the tag form is the same text without the heading or the indentation", () => {
  const markdown = formatTranscriptLocation(FOLDER, { conversationId: "conversation-1" })
  const tagged = formatTranscriptLocation(FOLDER, { conversationId: "conversation-1", useXml: true })
  assert.match(tagged, /^\n\n<transcript_location>\n/)
  assert.match(tagged, /\n<\/transcript_location>$/)
  assert.equal(tagged.includes("### Transcript location:"), false)
  assert.equal(tagged.includes("\n  "), false)
  // What the tag wraps is the markdown text with its heading off and its indentation removed.
  const inner = tagged.replace(/^\n\n<transcript_location>\n/, "").replace(/\n<\/transcript_location>$/, "")
  const unindented = markdown.replace("\n\n### Transcript location:\n", "").replace(/^ {2}/gm, "").trimEnd()
  assert.equal(unindented, inner)
})

test("an id that could address another directory is still one path component", () => {
  const text = formatTranscriptLocation(FOLDER, { conversationId: "../escape" })
  assert.equal(text.includes("/../"), false)
  assert.match(text, new RegExp(`${FOLDER}/\\.\\._2Fescape/`))
})

test("asking for a tag with no options at all still gives the folder form", () => {
  const tagged = formatTranscriptLocation(FOLDER, { useXml: true })
  assert.match(tagged, /^<transcript_location>|^\n\n<transcript_location>/)
  assert.match(tagged, /This folder contains full transcripts/)
  assert.equal(tagged.includes("### Transcript location:"), false)
})

import assert from "node:assert/strict"
import { test } from "node:test"

import { createDefaultProductionTranscriptMirrorProvider } from "../../source/adapters/interop/agent/production-transcript-mirror-adapter.ts"
import { FileTranscriptMirror } from "../../source/host/transcript/mirror/transcript-mirror.ts"

interface RoutedMirrorView {
  readonly journal: FileTranscriptMirror
  readonly legacy: {
    readonly previousRootPromptCount: number
    readonly options: { readonly transcriptsDir: string; readonly blobDbPaths: string[] }
  }
}

function options(rootPromptCount: number, dbPath: string) {
  return {
    transcriptsDir: "/data/transcripts",
    session: {
      dbPath,
      agentStore: {
        getConversationStateStructure: () => ({
          rootPromptMessagesJson: Array.from({ length: rootPromptCount }, (_, index) => index),
        }),
      },
    },
    pool: () => ({}),
    reportOutcome: () => {},
    isJournalEnabled: async () => true,
  }
}

test("the production mirror adapter shares its journal and seeds each runner's prompt cursor", () => {
  const createMirror = createDefaultProductionTranscriptMirrorProvider()
  const first = createMirror(options(2, "/data/agents/one/session.db") as never) as RoutedMirrorView
  const second = createMirror(options(5, "/data/agents/two/session.db") as never) as RoutedMirrorView

  assert.equal(first.journal instanceof FileTranscriptMirror, true)
  assert.ok(first.journal.deriver, "the production adapter supplies Slate turn and interop payload decoding")
  assert.equal(second.journal, first.journal, "all runners from one provider write the same journal")
  assert.deepEqual(first.legacy.options, {
    transcriptsDir: "/data/transcripts",
    blobDbPaths: ["/data/agents/one/conversation-blobs.db", "/data/agents/one/session.db"],
  })
  assert.deepEqual(second.legacy.options.blobDbPaths, [
    "/data/agents/two/conversation-blobs.db",
    "/data/agents/two/session.db",
  ])
  assert.deepEqual([first.legacy.previousRootPromptCount, second.legacy.previousRootPromptCount], [2, 5])
})

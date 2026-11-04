import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  DEBUGGING_THE_BOX_FILE,
  SLATE_APP_UI_FILE,
  SLATE_APP_UI_REFERENCE_DOC,
  SLATE_BOX_DEBUGGING_REFERENCE_DOC,
  SLATE_BOX_REFERENCE_DOCS,
  writeBoxReferenceDocs,
} from "../../source/host/runner/box-reference-docs.ts"

test("box guidance is written as two replaceable files with its recovery boundaries intact", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "slate-box-guidance-"))
  try {
    const written = await writeBoxReferenceDocs(dataDir)
    assert.deepEqual(written, [
      join(dataDir, DEBUGGING_THE_BOX_FILE),
      join(dataDir, SLATE_APP_UI_FILE),
    ])
    assert.deepEqual(SLATE_BOX_REFERENCE_DOCS.map(document => document.fileName), [
      DEBUGGING_THE_BOX_FILE,
      SLATE_APP_UI_FILE,
    ])

    const debugging = readFileSync(written[0]!, "utf8")
    const appGuide = readFileSync(written[1]!, "utf8")
    assert.equal(debugging, SLATE_BOX_DEBUGGING_REFERENCE_DOC)
    assert.equal(appGuide, SLATE_APP_UI_REFERENCE_DOC)
    assert.match(debugging, /box-doctor/)
    assert.match(debugging, /Update Slate's Computer/)
    assert.match(debugging, /Reset Slate's Computer/)
    assert.match(debugging, /request_box_help/)
    assert.match(appGuide, /General, Plugins, Team Setup, Appearance, and Updates/)
    assert.match(appGuide, /per-agent information pane/)
    assert.doesNotMatch(`${debugging}\n${appGuide}`, /\b(Docker|Chrome|Cursor)\b/i)

    writeFileSync(written[0]!, `${debugging}\nobsolete tail`)
    await writeBoxReferenceDocs(dataDir)
    assert.equal(readFileSync(written[0]!, "utf8"), debugging, "a refresh replaces the prior document")
    assert.deepEqual(readdirSync(dataDir).sort(), [DEBUGGING_THE_BOX_FILE, SLATE_APP_UI_FILE].sort())
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

/** Writes the box's authored guidance and prepares the model-visible data root. */

import { rm } from "node:fs/promises"
import { join } from "node:path"
import { writeFileAtomic } from "../../shared/node/atomic-write.ts"
import {
  ensureDataRootAlias,
  getSlateRootDir,
  SLATE_BOX_DATA_ROOT,
  SLATE_BOX_MODEL_VISIBLE_DATA_ROOT,
} from "../host-paths.ts"
import {
  LEGACY_SLATE_BOX_REFERENCE_DIR,
  SLATE_BOX_REFERENCE_DIR,
  SLATE_BOX_REFERENCE_DOCS,
} from "./box-reference-doc-content.ts"

export async function writeBoxReferenceDocs(
  referenceDir = SLATE_BOX_REFERENCE_DIR,
): Promise<string[]> {
  const encoder = new TextEncoder()
  const paths: string[] = []
  for (const document of SLATE_BOX_REFERENCE_DOCS) {
    const path = join(referenceDir, document.fileName)
    await writeFileAtomic(path, encoder.encode(document.contents))
    paths.push(path)
  }
  return paths
}

export async function provisionBoxPromptArtifacts(): Promise<void> {
  const dataRoot = getSlateRootDir()
  const tasks = [
    dataRoot === SLATE_BOX_DATA_ROOT
      ? ensureDataRootAlias({
        dataRoot: SLATE_BOX_DATA_ROOT,
        aliasPath: SLATE_BOX_MODEL_VISIBLE_DATA_ROOT,
      })
      : Promise.resolve(),
    writeBoxReferenceDocs(),
    rm(LEGACY_SLATE_BOX_REFERENCE_DIR, { recursive: true, force: true }),
  ]

  const results = await Promise.allSettled(tasks)
  const rejected = results.find(result => result.status === "rejected")
  if (rejected?.status === "rejected") throw rejected.reason
}

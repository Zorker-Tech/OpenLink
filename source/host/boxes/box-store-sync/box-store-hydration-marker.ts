import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

import { errorLogTag } from "../../../shared/errors/summary.ts"
import { reportBoxStoreDiagnostic } from "./box-store-diagnostics.ts"

export async function writeHydrationHandoffMarker(markerPath: string): Promise<void> {
  const directoryPath = dirname(markerPath)
  const temporaryPath = `${markerPath}.${process.pid}.tmp`
  await mkdir(directoryPath, { recursive: true })

  try {
    const temporaryFile = await open(temporaryPath, "w", 0o600)
    try {
      await temporaryFile.writeFile("complete\n")
      await temporaryFile.sync()
    } finally {
      await temporaryFile.close()
    }

    await rename(temporaryPath, markerPath)
    const directory = await open(directoryPath, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch((error) => {
      reportBoxStoreDiagnostic({ extension: "box_store", kind: "hydration_temp_cleanup_failed", errorClass: errorLogTag(error) })
    })
  }
}

export async function removeHydrationHandoffMarker(markerPath: string): Promise<void> {
  const directoryPath = dirname(markerPath)
  await rm(markerPath, { force: true })
  await mkdir(directoryPath, { recursive: true })

  const directory = await open(directoryPath, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

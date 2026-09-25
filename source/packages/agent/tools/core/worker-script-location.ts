/**
 * Where the worker scripts a tool spawns actually are.
 *
 * A tool that runs work in a worker process needs the worker's file, and the file's location depends on
 * how the platform was started: next to the module when it is running from source, and next to the entry
 * point when it is running from a bundle. The extension matters as much as the directory — a worker
 * resolved as `.ts` when the runtime was handed `.js` cannot be started — so both are decided together by
 * looking for the files rather than by assuming.
 *
 * When neither is found the module's own directory is used, which is where a worker belongs and gives the
 * caller a path to report rather than a crash here.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function resolveWorkerLocation(moduleUrl: string, representativeWorker: string): {
  dir: string
  extension: "ts" | "js"
} {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl))
  if (fs.existsSync(path.join(moduleDir, `${representativeWorker}.ts`))) return { dir: moduleDir, extension: "ts" }
  if (fs.existsSync(path.join(moduleDir, `${representativeWorker}.js`))) return { dir: moduleDir, extension: "js" }
  const entry = process.argv[1]
  if (entry) {
    const entryDir = path.dirname(entry)
    if (fs.existsSync(path.join(entryDir, `${representativeWorker}.js`))) return { dir: entryDir, extension: "js" }
  }
  return { dir: moduleDir, extension: "js" }
}

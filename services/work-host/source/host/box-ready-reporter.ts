import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

export const BOX_READY_STAGE_MARKER_PATH = "/tmp/slate-box-ready-stage"
export const BOX_READY_REPORT_ATTEMPTS = 3
export const BOX_READY_REPORT_RETRY_MS = 30_000

export interface BoxReadyReporterOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly now?: () => number
  readonly readMarker?: () => Promise<string | null>
  readonly writeMarker?: (bootId: string) => Promise<void>
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly reportConfirmed?: (report: { readonly stage: "ready"; readonly durationMs: number }) => Promise<boolean>
}

export async function reportBoxReady(options: BoxReadyReporterOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env
  const bootId = environment.SLATE_BOX_BOOT_ID?.trim()
  const bootStartedAtMs = Number(environment.SLATE_BOX_BOOT_STARTED_AT_MS)
  if (!bootId || !Number.isFinite(bootStartedAtMs)) return

  const readMarker = options.readMarker ??
    (async () => readFile(BOX_READY_STAGE_MARKER_PATH, "utf8").catch(() => null))
  if ((await readMarker()) === bootId) return
  if (options.reportConfirmed === undefined) return

  const readyDurationMs = Math.max(0, (options.now ?? Date.now)() - bootStartedAtMs)
  const writeMarker = options.writeMarker ??
    (async (id: string) => writeFile(BOX_READY_STAGE_MARKER_PATH, id))
  const wait = options.wait ?? (async (milliseconds: number) => { await delay(milliseconds) })

  for (let attempt = 1; attempt <= BOX_READY_REPORT_ATTEMPTS; attempt += 1) {
    if (await options.reportConfirmed({ stage: "ready", durationMs: readyDurationMs })) {
      try {
        await writeMarker(bootId)
      } catch {
        // The report landed; a missing marker can only cause a duplicate report after restart.
      }
      return
    }
    if (attempt < BOX_READY_REPORT_ATTEMPTS) await wait(BOX_READY_REPORT_RETRY_MS)
  }
}

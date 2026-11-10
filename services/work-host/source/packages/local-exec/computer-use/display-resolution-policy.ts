import type { ScreenPair } from "./scaling.ts"
import type { DisplayInfo } from "./display-contracts.ts"

export const API_FRAME_WIDTH = 1280

interface ActiveMode {
  size?: { width: number; height: number }
  refresh?: number
}

function activeModeDetails(line: string): ActiveMode {
  const resolution = line.trim().match(/^(\d+)x(\d+)/)
  const rate = line.match(/(\d+(?:\.\d+)?)\*(?:\+)?/)

  return {
    ...(resolution?.[1] === undefined || resolution[2] === undefined
      ? {}
      : { size: { width: Number.parseInt(resolution[1], 10), height: Number.parseInt(resolution[2], 10) } }),
    ...(rate?.[1] === undefined ? {} : { refresh: Number.parseFloat(rate[1]) }),
  }
}

function currentScreenSize(output: string): { width: number; height: number } | undefined {
  const summary = output.match(/current\s+(\d+)\s*x\s*(\d+)/i)
  if (summary?.[1] === undefined || summary[2] === undefined) return undefined
  return { width: Number.parseInt(summary[1], 10), height: Number.parseInt(summary[2], 10) }
}

export function parseDisplayIndex(displayName: string): number {
  const separator = displayName.lastIndexOf(":")
  if (separator < 0) throw new Error(`Invalid X11 display string: ${displayName} (missing ':')`)

  const encodedIndex = displayName.slice(separator + 1).split(".")[0]!
  const index = Number.parseInt(encodedIndex, 10)
  if (!Number.isFinite(index) || index < 0) {
    throw new Error(`Invalid X11 display number in: ${displayName} (parsed: ${encodedIndex})`)
  }
  return index
}

export function parseDisplayModes(output: string): DisplayInfo {
  let size: { width: number; height: number } | undefined
  let refreshRate: number | undefined

  for (const row of output.split("\n")) {
    if (!row.includes("*")) continue
    const active = activeModeDetails(row)
    if (active.size !== undefined) size = active.size
    if (active.refresh !== undefined && active.refresh > 0 && active.refresh <= 500) {
      refreshRate = Math.round(active.refresh)
    }
    if (size?.width && size.height) break
  }

  if (size === undefined || !size.width || !size.height) size = currentScreenSize(output) ?? size
  if (size === undefined || !size.width || !size.height) {
    throw new Error(`Could not detect display resolution from xrandr output.\nExpected a line with '*' indicating active mode, or 'current WxH'.\nxrandr output:\n${output}`)
  }

  return { ...size, refreshRate: refreshRate ?? 60 }
}

export function createDisplayResolution(width: number, height: number): ScreenPair {
  return {
    display: { width, height },
    api: { width: API_FRAME_WIDTH, height: Math.round(API_FRAME_WIDTH / (width / height)) },
  }
}

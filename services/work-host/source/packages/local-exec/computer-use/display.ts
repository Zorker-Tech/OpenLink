import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { createDisplayResolution, parseDisplayModes } from "./display-resolution-policy.ts"
import type { DisplayInfo } from "./display-contracts.ts"

const runDisplayCommand = promisify(execFile)

export {
  API_FRAME_WIDTH,
  API_FRAME_WIDTH as API_WIDTH,
  createDisplayResolution,
  createDisplayResolution as buildResolutionConfig,
  parseDisplayIndex,
  parseDisplayIndex as parseDisplayNum,
  parseDisplayModes,
  parseDisplayModes as parseXrandrOutput,
} from "./display-resolution-policy.ts"
export type { DisplayInfo } from "./display-contracts.ts"

/** Reads the active X display size and the matching fixed-width input frame. */
export async function detectDisplay(displayName: string): Promise<{
  display: DisplayInfo
  resolution: ReturnType<typeof createDisplayResolution>
  resolutionString: string
}> {
  const { stdout } = await runDisplayCommand("xrandr", ["--display", displayName], { timeout: 5_000 })
  const display = parseDisplayModes(stdout)
  return {
    display,
    resolution: createDisplayResolution(display.width, display.height),
    resolutionString: `${display.width}x${display.height}`,
  }
}

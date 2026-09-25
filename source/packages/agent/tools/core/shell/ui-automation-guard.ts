/**
 * What a shell command may not do while it is the model's only way to reach the desktop.
 *
 * Driving the desktop by script — xdotool and its relatives, or a browser started with a debugging port
 * so it can be puppeteered — is a way to reach the user's screen without the platform's own desktop tool
 * seeing it: no approval, no screenshot, no record. So those commands are refused with an explanation
 * that names the tool to use instead.
 *
 * One exception exists, and it is not a loophole: a command that asks the platform's own host to take a
 * screenshot is the platform taking it, so it is allowed through the same check that would otherwise
 * refuse a screenshot tool.
 */

export const MODEL_FACING_SHELL_UI_AUTOMATION_BLOCK_REASON =
  "Direct UI automation through Shell is blocked. Use the Computer tool for pixel-level actions on the desktop."

const UI_AUTOMATION_TOOL_PATTERN =
  /\b(xdotool|wmctrl|xte|ydotool|osascript|cliclick|pyautogui|pynput|robotjs|sikuli)\b|Quartz\.CGEvent|ApplicationServices\.framework/i
const BROWSER_REMOTE_DEBUG_PATTERN =
  /--remote-debugging-port\b|--remote-debugging-pipe\b|chrome-devtools-protocol|puppeteer|playwright(?:@[^\s]+)?\s+(?:codegen|open)\b|chromedriver\b|selenium-server\b/i
const INTERNAL_HOST_SCREENSHOT_PATTERN = /control-sand(?:\.mjs)?\b[^\n]*\bscreenshot\b/i

export function isInternalHostScreenshotShellCommand(command: string): boolean {
  return INTERNAL_HOST_SCREENSHOT_PATTERN.test(command)
}

export function checkModelFacingShellUiAutomation(
  command: string,
): { allow: true } | { allow: false; reason: string } {
  if (UI_AUTOMATION_TOOL_PATTERN.test(command) || BROWSER_REMOTE_DEBUG_PATTERN.test(command)) {
    return { allow: false, reason: MODEL_FACING_SHELL_UI_AUTOMATION_BLOCK_REASON }
  }
  if (isInternalHostScreenshotShellCommand(command)) return { allow: true }
  return { allow: true }
}

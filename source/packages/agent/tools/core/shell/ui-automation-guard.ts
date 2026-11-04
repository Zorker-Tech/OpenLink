/** Refuse shell commands that try to control the desktop outside the visible computer capability. */

export const SHELL_DESKTOP_CONTROL_REFUSAL =
  "Shell commands that manipulate the desktop or drive a browser are blocked. Use the Computer tool for visible, user-approved actions."

const DESKTOP_CONTROL_COMMAND_PATTERN =
  /\b(xdotool|wmctrl|xte|ydotool|osascript|cliclick|pyautogui|pynput|robotjs|sikuli)\b|Quartz\.CGEvent|ApplicationServices\.framework/i
const BROWSER_CONTROL_CHANNEL_PATTERN =
  /--remote-debugging-port\b|--remote-debugging-pipe\b|chrome-devtools-protocol|puppeteer|playwright(?:@[^\s]+)?\s+(?:codegen|open)\b|chromedriver\b|selenium-server\b/i
const INTERNAL_HOST_SCREENSHOT_PATTERN = /control-slate(?:\.mjs)?\b[^\n]*\bscreenshot\b/i

export function isHostOwnedScreenshotCommand(command: string): boolean {
  return INTERNAL_HOST_SCREENSHOT_PATTERN.test(command)
}

function needsVisibleComputerControl(command: string): boolean {
  return DESKTOP_CONTROL_COMMAND_PATTERN.test(command) || BROWSER_CONTROL_CHANNEL_PATTERN.test(command)
}

export type ShellUiAutomationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string }

export function checkShellDesktopControl(
  command: string,
): ShellUiAutomationDecision {
  if (needsVisibleComputerControl(command)) {
    return { allow: false, reason: SHELL_DESKTOP_CONTROL_REFUSAL }
  }
  if (isHostOwnedScreenshotCommand(command)) return { allow: true }
  return { allow: true }
}

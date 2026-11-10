/** The mode-change reminder retained for older prompt variants. */

import { describeModeSwitch } from "../utils/mode-switch-reminder.ts"

export interface SwitchModeReminderProps {
  readonly currentMode: string
  readonly targetModes?: unknown
  readonly fromModes?: unknown
}

export function SwitchModeReminderSnippet({ currentMode }: SwitchModeReminderProps): string {
  const modeStatement = describeModeSwitch(currentMode)
  return `<system_reminder>\n${modeStatement}\n</system_reminder>`
}

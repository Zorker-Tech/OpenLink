/**
 * What an agent is told when its mode changes.
 *
 * Modes are not just a setting: the agent's instructions differ per mode, and a model that is not told
 * it has changed will keep following the previous mode's rules. The statement therefore says which
 * mode it is in *and* that the previous one has ended — that second sentence is what stops the old
 * instructions from bleeding through.
 */

const MODE_DISPLAY_NAMES = {
  agent: "Agent",
  plan: "Plan",
  debug: "Debug",
  chat: "Ask",
  multitask: "Multitask",
} as const

function isKnownMode(mode: string): mode is keyof typeof MODE_DISPLAY_NAMES {
  return Object.hasOwn(MODE_DISPLAY_NAMES, mode)
}

export function buildCurrentModeStatement(
  currentMode: string,
  _targetModes: unknown,
  _fromModes: unknown,
): string {
  const displayName = isKnownMode(currentMode) ? MODE_DISPLAY_NAMES[currentMode] : currentMode
  return `You are now in ${displayName} mode. You have EXITED your previous mode. Continue with the task in the new mode.`
}

/** Describe the active agent mode and retire the instructions from the previous one. */

const MODE_LABELS = new Map<string, string>([
  ["agent", "Agent"],
  ["plan", "Plan"],
  ["debug", "Debug"],
  ["chat", "Ask"],
  ["multitask", "Multitask"],
]);

export function describeModeSwitch(currentMode: string): string {
  const label = MODE_LABELS.get(currentMode) ?? currentMode;
  return [
    `You are now in ${label} mode.`,
    "You have EXITED your previous mode.",
    "Continue with the task in the new mode.",
  ].join(" ");
}

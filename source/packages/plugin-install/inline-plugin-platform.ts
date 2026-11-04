import { platform } from "node:os";
import type { InlineHook } from "./inline-plugin-contracts.ts";

type OperatingSystemName = "Windows" | "Macintosh" | "Linux";

function currentOperatingSystemName(): OperatingSystemName {
  const currentPlatform = platform();
  if (currentPlatform === "win32") return "Windows";
  if (currentPlatform === "darwin") return "Macintosh";
  return "Linux";
}

export function inlineHookAppliesToThisPlatform(hook: InlineHook): boolean {
  const platforms = hook.operatingSystems;
  return platforms == null || platforms.length === 0 || platforms.includes(currentOperatingSystemName());
}

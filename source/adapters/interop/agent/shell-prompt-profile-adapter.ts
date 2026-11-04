import {
  SlateShellPromptProfile,
  type SlateShellPromptProfile as ShellPromptProfile,
} from "../../../packages/agent/tools/core/shell/shell-tool-description.ts"

/** Reduce external model-version labels to the behavior Slate needs from a shell prompt. */
export function shellPromptProfileFromInterop(promptVersion?: string): ShellPromptProfile {
  switch (promptVersion) {
    case "cursor-0226": return SlateShellPromptProfile.STREAMING
    case "dsv3-1205": return SlateShellPromptProfile.SESSION
    case "dsv3-1018": return SlateShellPromptProfile.INITIAL
    case undefined: return SlateShellPromptProfile.SESSION
    default: return SlateShellPromptProfile.INITIAL
  }
}

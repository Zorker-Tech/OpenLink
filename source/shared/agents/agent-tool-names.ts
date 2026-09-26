/**
 * The names the platform's own tools are known by.
 *
 * A tool's name is what the model asks for it by, and the platform names its own tools consistently: the ones that run
 * in a box, the ones that run on the user's own machine, and the machine a tool acts on when the user has one.
 */
export const SLATE_BOX_SHELL_TOOL_NAME = "Shell";
export const SLATE_BOX_READ_TOOL_NAME = "Read";
export const SLATE_BOX_AWAIT_SHELL_TOOL_NAME = "AwaitShell";
export const SLATE_EXTERNAL_SHELL_TOOL_NAME = "ExternalShell";
export const SLATE_EXTERNAL_READ_TOOL_NAME = "ExternalRead";
export const SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME = "AwaitExternalShell";
export const SLATE_DEFAULT_EXTERNAL_MACHINE_ID = "user-computer";

export interface SlateExternalMachine {
  readonly id: string;
  readonly label: string;
}

export const SLATE_USER_COMPUTER: SlateExternalMachine = {
  id: "user-computer",
  label: "the user's computer",
};

export const SLATE_EXTERNAL_MACHINES: Readonly<Record<string, SlateExternalMachine>> = {
  "user-computer": SLATE_USER_COMPUTER,
};

export function resolveSlateExternalMachine(
  id = SLATE_DEFAULT_EXTERNAL_MACHINE_ID,
): SlateExternalMachine | undefined {
  return SLATE_EXTERNAL_MACHINES[id];
}

export type SlateDualSurfaceToolTelemetry = {
  readonly toolName: string;
  readonly surface: "box" | "external";
};

export function slateDualSurfaceToolTelemetry(
  toolName: string,
): SlateDualSurfaceToolTelemetry | undefined {
  switch (toolName) {
    case SLATE_BOX_SHELL_TOOL_NAME:
    case SLATE_BOX_READ_TOOL_NAME:
    case SLATE_BOX_AWAIT_SHELL_TOOL_NAME:
      return { toolName, surface: "box" };
    case SLATE_EXTERNAL_SHELL_TOOL_NAME:
    case SLATE_EXTERNAL_READ_TOOL_NAME:
    case SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME:
      return { toolName, surface: "external" };
    default:
      return undefined;
  }
}

/**
 * The names the platform's own tools are known by.
 *
 * A tool's name is what the model asks for it by, and the platform names its own tools consistently: the ones that run
 * in a box, and the ones that run on the user's own machine.
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
  id: SLATE_DEFAULT_EXTERNAL_MACHINE_ID,
  label: "the user's computer",
};

/** The machines the platform knows how to run a tool on, by id. */
export const SLATE_EXTERNAL_MACHINES: Readonly<Record<string, SlateExternalMachine>> = {
  [SLATE_DEFAULT_EXTERNAL_MACHINE_ID]: SLATE_USER_COMPUTER,
};

/** A machine by its id, or nothing when this build runs no tool there. */
export function resolveSlateExternalMachine(id = SLATE_DEFAULT_EXTERNAL_MACHINE_ID): SlateExternalMachine | undefined {
  return SLATE_EXTERNAL_MACHINES[id];
}

export type SlateDualSurfaceToolTelemetry = {
  readonly toolName: string;
  readonly surface: "box" | "external";
};

/**
 * Which surface a tool of ours runs on, and nothing for a tool that is not one of ours.
 *
 * The pairing is a table rather than a branch: a tool added to one side without being added here is a tool whose
 * telemetry says nothing about it, which is what the return type lets a caller notice.
 */
const TOOL_SURFACES: ReadonlyMap<string, SlateDualSurfaceToolTelemetry["surface"]> = new Map<string, SlateDualSurfaceToolTelemetry["surface"]>([
  [SLATE_BOX_SHELL_TOOL_NAME, "box"],
  [SLATE_BOX_READ_TOOL_NAME, "box"],
  [SLATE_BOX_AWAIT_SHELL_TOOL_NAME, "box"],
  [SLATE_EXTERNAL_SHELL_TOOL_NAME, "external"],
  [SLATE_EXTERNAL_READ_TOOL_NAME, "external"],
  [SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME, "external"],
]);

export function slateDualSurfaceToolTelemetry(toolName: string): SlateDualSurfaceToolTelemetry | undefined {
  const surface = TOOL_SURFACES.get(toolName);
  return surface === undefined ? undefined : { toolName, surface };
}

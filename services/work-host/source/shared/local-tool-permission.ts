export const SLATE_LOCAL_TOOL_ACTIONS = ["run-command", "send-input", "read-file", "list-directory", "write-file"] as const;
export type SlateLocalToolAction = (typeof SLATE_LOCAL_TOOL_ACTIONS)[number];

export const SLATE_LOCAL_TOOL_PERMISSIONS = ["always", "ask", "never"] as const;
export type SlateLocalToolPermission = (typeof SLATE_LOCAL_TOOL_PERMISSIONS)[number];
export const SLATE_DEFAULT_LOCAL_TOOL_PERMISSION: SlateLocalToolPermission = "ask";

/**
 * A permission's rank is its position from the narrow end of the list above: "never" is 0, "ask" is 1 and "always" is
 * the greatest, so a wider choice is a higher number.
 */
export const SLATE_LOCAL_TOOL_PERMISSION_RANK: Readonly<Record<SlateLocalToolPermission, number>> = Object.fromEntries(
  [...SLATE_LOCAL_TOOL_PERMISSIONS].reverse().map((permission, rank) => [permission, rank]),
) as Record<SlateLocalToolPermission, number>;

/**
 * Whether a candidate is one of a fixed vocabulary. The host asks the same question of two vocabularies — the actions it
 * can run locally, and the permissions it can run them under — so the question is written once.
 */
function isOneOf<Value extends string>(vocabulary: readonly Value[], candidate: unknown): candidate is Value {
  return typeof candidate === "string" && (vocabulary as readonly string[]).includes(candidate);
}

export function isSlateLocalToolAction(candidate: unknown): candidate is SlateLocalToolAction {
  return isOneOf(SLATE_LOCAL_TOOL_ACTIONS, candidate);
}

export function isSlateLocalToolPermission(candidate: unknown): candidate is SlateLocalToolPermission {
  return isOneOf(SLATE_LOCAL_TOOL_PERMISSIONS, candidate);
}

/** A permission read from outside comes back as itself when this build knows it, and as the default when it does not. */
export function normalizeSlateLocalToolPermission(candidate: unknown): SlateLocalToolPermission {
  return isSlateLocalToolPermission(candidate) ? candidate : SLATE_DEFAULT_LOCAL_TOOL_PERMISSION;
}

/** A choice is narrowed to the administrator's ceiling when the administrator allows less than the choice asks for. */
export function resolveSlateLocalToolPermission(choice: SlateLocalToolPermission, adminCeiling?: SlateLocalToolPermission): SlateLocalToolPermission {
  if (adminCeiling === undefined) return choice;
  return SLATE_LOCAL_TOOL_PERMISSION_RANK[choice] <= SLATE_LOCAL_TOOL_PERMISSION_RANK[adminCeiling] ? choice : adminCeiling;
}

export const SLATE_LOCAL_TOOL_PERMISSIONS = ["always", "ask", "never"] as const;
export type SlateLocalToolPermission = (typeof SLATE_LOCAL_TOOL_PERMISSIONS)[number];
export const SLATE_DEFAULT_LOCAL_TOOL_PERMISSION: SlateLocalToolPermission = "ask";
export const SLATE_LOCAL_TOOL_ACTIONS = ["run-command", "send-input", "read-file", "list-directory", "write-file"] as const;
export type SlateLocalToolAction = (typeof SLATE_LOCAL_TOOL_ACTIONS)[number];

export function isSlateLocalToolAction(value: unknown): value is SlateLocalToolAction {
  return typeof value === "string" && (SLATE_LOCAL_TOOL_ACTIONS as readonly string[]).includes(value);
}

export function isSlateLocalToolPermission(value: unknown): value is SlateLocalToolPermission {
  return typeof value === "string" && (SLATE_LOCAL_TOOL_PERMISSIONS as readonly string[]).includes(value);
}

export function normalizeSlateLocalToolPermission(value: unknown): SlateLocalToolPermission {
  return isSlateLocalToolPermission(value) ? value : SLATE_DEFAULT_LOCAL_TOOL_PERMISSION;
}

export const SLATE_LOCAL_TOOL_PERMISSION_RANK: Readonly<Record<SlateLocalToolPermission, number>> = { never: 0, ask: 1, always: 2 };

export function resolveSlateLocalToolPermission(choice: SlateLocalToolPermission, adminCeiling?: SlateLocalToolPermission): SlateLocalToolPermission {
  if (adminCeiling === undefined) return choice;
  return SLATE_LOCAL_TOOL_PERMISSION_RANK[choice] <= SLATE_LOCAL_TOOL_PERMISSION_RANK[adminCeiling] ? choice : adminCeiling;
}

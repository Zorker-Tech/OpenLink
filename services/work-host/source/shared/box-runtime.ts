/**
 * Where a box runs.
 *
 * A box is either remote — a machine the platform's service provides — or a container on this machine, and the default
 * is the remote one, since a local container is something a user opts into.
 */
export type BoxRuntime = "remote" | "local-docker";

export const DEFAULT_SLATE_BOX_RUNTIME: BoxRuntime = "remote";

export function isBoxRuntime(value: unknown): value is BoxRuntime {
  return value === "remote" || value === "local-docker";
}

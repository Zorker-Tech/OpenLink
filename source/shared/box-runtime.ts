/**
 * Where a box runs.
 *
 * A box is either remote — a machine the platform's service provides — or a container on this machine, and the default
 * is the remote one, since a local container is something a user opts into.
 */
export type SandBoxRuntime = "remote" | "local-docker";

export const DEFAULT_SLATE_BOX_RUNTIME: SandBoxRuntime = "remote";

export function isSandBoxRuntime(value: unknown): value is SandBoxRuntime {
  return value === "remote" || value === "local-docker";
}

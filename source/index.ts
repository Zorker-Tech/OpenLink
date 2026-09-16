/**
 * Work platform entry surface.
 *
 * The platform ships with the desktop app and runs in its Node runtime. This module will own
 * startup composition once the layers are implemented:
 *
 *     gateway  --(commands, scope)-->  coordinator / host
 *     host     --(typed ports)------->  local-exec, box-exec, bridges
 *
 * Skeleton only: no layer is implemented yet. What is fixed already is the shape:
 *
 * - the gateway exposes a static command catalogue (see `@slate/work-protocol`) and rejects
 *   anything not in it, so the capability surface stays auditable;
 * - the host owns persisted state (agents, transcripts, runs, automations, workflows, rooms,
 *   boxes, gateway lifecycle), which is why scheduled work lives there and not in the renderer;
 * - local-exec and box-exec are separate processes with their own identity and readiness, not
 *   functions inside the host.
 */

/** Layers, in dependency order. Each maps to a directory under `source/`. */
export const WORK_LAYERS = ["gateway", "coordinator", "host", "local-exec", "box-exec", "shared"] as const

export type WorkLayer = (typeof WORK_LAYERS)[number]

/** Version of the Work platform surface this scaffold targets. */
export const WORK_PLATFORM_VERSION = 0

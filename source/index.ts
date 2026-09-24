/**
 * Slate Assistant (Work mode) entry surface.
 *
 * The platform ships with the desktop app and runs in its Node runtime. Layers land one module at a
 * time under `source/`; this module describes the shape they assemble into and will own startup
 * composition once they are all in place:
 *
 *     gateway  --(commands, scope)-->  coordinator / host
 *     host     --(typed ports)------->  local-exec, box-exec, bridges
 *
 * What is fixed already is the shape:
 *
 * - the gateway exposes a static command catalogue (see `@slate/work-protocol`) and rejects
 *   anything not in it, so the capability surface stays auditable;
 * - the host owns persisted state (agents, transcripts, runs, automations, workflows, rooms,
 *   boxes, gateway lifecycle), which is why scheduled work lives there and not in the renderer;
 * - local-exec and box-exec are separate processes with their own identity and readiness, not
 *   functions inside the host.
 */

/** Slate Assistant layers, in dependency order. Each maps to a directory under `source/`. */
export const WORK_LAYERS = ["gateway", "coordinator", "host", "local-exec", "box-exec", "shared"] as const

export type WorkLayer = (typeof WORK_LAYERS)[number]

/** Version of the Slate Assistant surface this scaffold targets. */
export const WORK_PLATFORM_VERSION = 0

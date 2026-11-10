/**
 * Public entry surface for the Slate Work SDK.
 *
 * The platform's process entrypoints are available from focused subpaths; the root export contains
 * the typed Work client, route contracts and public domain values.
 *
 *     gateway  --(commands, scope)-->  coordinator / host
 *     host     --(typed ports)------->  local-exec, box-exec, bridges
 *
 * The service API stays auditable:
 *
 * - the gateway exposes a static command catalogue (see `@slate/work-protocol`) and rejects
 *   anything not in it, so the capability surface stays auditable;
 * - the host owns persisted state (agents, transcripts, runs, automations, workflows, rooms,
 *   boxes, gateway lifecycle), which is why scheduled work lives there and not in the renderer;
 * - local-exec and box-exec are separate processes with their own identity and readiness, not
 *   functions inside the host.
 */

/** Slate Work layers, in dependency order. */
export const WORK_LAYERS = ["gateway", "coordinator", "host", "local-exec", "box-exec", "shared"] as const

export type WorkLayer = (typeof WORK_LAYERS)[number]

/** Version of the published SDK package. */
export const WORK_HOST_SDK_VERSION = "0.0.1" as const

/** Version of the Work platform contract scaffold. */
export const WORK_PLATFORM_VERSION = 0

export * from "@slate/work-domain"
export * from "@slate/work-protocol"

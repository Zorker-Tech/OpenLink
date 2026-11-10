/**
 * Getting the context a request needs, from wherever it can be had.
 *
 * A request's context — the rules, skills, files and folders that belong to it — may already be in
 * hand when the turn starts, or may have to be asked of the workspace. Both paths end here so the rest
 * of the turn has one shape to work with, and the result says which path it came from, because
 * "provided" and "fetched" behave differently when something has to be refreshed.
 *
 * Two adjustments apply on the way, and both are why a provided context can come back modified. Agent
 * notes live under a session-specific folder inside the project, and the shared notes folder is cleared
 * for a meta agent, which writes to its own session rather than to the project's shared notes. And a
 * context may be scoped to particular people: rules and skills that name someone other than the actor
 * are dropped before the turn sees them.
 *
 * The redacted variant is the same work on the other side of the privacy boundary: the context goes
 * back out under the privacy mode it came in with, rather than a mode invented here.
 */

import type { Context } from "../../context/context.ts"
import { createSpan } from "../../context/telemetry.ts"
import {
  createRequestContextArgs,
  decodeRedactedRequestContext,
  encodeRedactedRequestContext,
  projectRequestContextResult,
  type InteropRequestContext,
  type InteropRequestContextArgs,
  type InteropRequestContextResult,
  type RedactedRequestContext,
} from "../../../adapters/interop/agent/request-context-adapter.ts"
import { requestContextExecutorResource } from "../../agent-exec/request-context-operation.ts"
import { getRequestPathModule } from "./request-paths.ts"
import { filterByActorIdentity, type ScopedItem } from "./rule-scoping.ts"

export interface RequestContextResolveOptions {
  readonly notesSessionId?: string | undefined
  readonly metaAgentNotesEnabled?: boolean | undefined
  readonly actorIdentity?: { readonly email: string } | undefined
}

export interface RequestContextResources {
  get(resource: typeof requestContextExecutorResource): {
    execute(ctx: Context, args: InteropRequestContextArgs): Promise<InteropRequestContextResult>
  }
}

export type RequestContextProvenance = "providedModified" | "providedUnchanged" | "executorFetched"

/** Drops the rules and skills scoped to someone else; says whether anything was dropped. */
function filterRequestContextByActorIdentity(
  requestContext: Pick<InteropRequestContext, "rules" | "agentSkills">,
  actorIdentity: RequestContextResolveOptions["actorIdentity"],
): boolean {
  const filteredRules = filterByActorIdentity(
    requestContext.rules as unknown as readonly ScopedItem[],
    actorIdentity,
  ) as unknown as InteropRequestContext["rules"]
  const filteredAgentSkills = filterByActorIdentity(
    requestContext.agentSkills as unknown as readonly ScopedItem[],
    actorIdentity,
  ) as unknown as InteropRequestContext["agentSkills"]
  const changed = filteredRules.length !== requestContext.rules.length ||
    filteredAgentSkills.length !== requestContext.agentSkills.length
  requestContext.rules = filteredRules
  requestContext.agentSkills = filteredAgentSkills
  return changed
}

export async function resolveRequestContext({ parentCtx, maybeRequestContext, resources, options }: {
  readonly parentCtx: Context
  readonly maybeRequestContext?: InteropRequestContext
  readonly resources: RequestContextResources
  readonly options?: RequestContextResolveOptions
}): Promise<{ readonly requestContext: InteropRequestContext; readonly provenance: RequestContextProvenance }> {
  using span = createSpan(parentCtx.withName("getRequestContext"))
  const ctx = span.ctx

  /** Points the notes folders at this session; says whether anything changed. */
  const applyAgentNotesFolderOverrides = (requestContext: InteropRequestContext): boolean => {
    const env = requestContext.env
    if (env === undefined) return false
    const projectFolder = env.projectFolder
    if (projectFolder === undefined || projectFolder.length === 0) return false
    const pathModule = getRequestPathModule(requestContext)
    const notesSessionId = options?.notesSessionId
    const metaAgentNotesEnabled = options?.metaAgentNotesEnabled === true
    let changed = false
    if (notesSessionId !== undefined && notesSessionId.length > 0) {
      const notesFolder = pathModule.join(projectFolder, "agent-notes", notesSessionId)
      // A meta agent always writes to its own folder; anything else only when it had none.
      if (metaAgentNotesEnabled || (env.agentConversationNotesFolder?.length ?? 0) === 0) {
        if (env.agentConversationNotesFolder !== notesFolder) {
          env.agentConversationNotesFolder = notesFolder
          changed = true
        }
      }
    }
    if (metaAgentNotesEnabled && env.agentSharedNotesFolder !== "") {
      env.agentSharedNotesFolder = ""
      changed = true
    }
    return changed
  }

  if (maybeRequestContext !== undefined) {
    const notesChanged = applyAgentNotesFolderOverrides(maybeRequestContext)
    const actorFilteringChanged = filterRequestContextByActorIdentity(maybeRequestContext, options?.actorIdentity)
    return {
      requestContext: maybeRequestContext,
      provenance: notesChanged || actorFilteringChanged ? "providedModified" : "providedUnchanged",
    }
  }

  const requestContextExecutor = resources.get(requestContextExecutorResource)
  const requestContextResult = projectRequestContextResult(
    await requestContextExecutor.execute(ctx, createRequestContextArgs(options?.notesSessionId)),
  )
  if (requestContextResult.kind === "unavailable") throw new Error("Failed to get request context")
  const requestContext = requestContextResult.requestContext
  applyAgentNotesFolderOverrides(requestContext)
  filterRequestContextByActorIdentity(requestContext, options?.actorIdentity)
  return { requestContext, provenance: "executorFetched" }
}

export async function getRequestContext(
  parentCtx: Context,
  maybeRequestContext: InteropRequestContext | undefined,
  resources: RequestContextResources,
  options?: RequestContextResolveOptions,
): Promise<InteropRequestContext> {
  const resolved = await resolveRequestContext({
    parentCtx,
    resources,
    ...(maybeRequestContext === undefined ? {} : { maybeRequestContext }),
    ...(options === undefined ? {} : { options }),
  })
  return resolved.requestContext
}

export async function getRedactedRequestContext(
  parentCtx: Context,
  maybeRequestContext: RedactedRequestContext | undefined,
  resources: RequestContextResources,
  options?: RequestContextResolveOptions,
): Promise<RedactedRequestContext> {
  const unredacted = await getRequestContext(
    parentCtx,
    maybeRequestContext === undefined ? undefined : decodeRedactedRequestContext(maybeRequestContext),
    resources,
    options,
  )
  return encodeRedactedRequestContext(unredacted, maybeRequestContext)
}

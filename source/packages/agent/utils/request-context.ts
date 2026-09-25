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
import { PrivacyCapability } from "../../redaction/classification.ts"
import { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { RequestContextArgs, type RequestContext, type RequestContextResult } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import {
  fromRedactedRequestContext,
  toRedactedRequestContext,
} from "../../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
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
    execute(ctx: Context, args: RequestContextArgs): Promise<RequestContextResult>
  }
}

export type RequestContextProvenance = "providedModified" | "providedUnchanged" | "executorFetched"

type RedactedRequestContext = Parameters<typeof fromRedactedRequestContext>[0]

/** Drops the rules and skills scoped to someone else; says whether anything was dropped. */
function filterRequestContextByActorIdentity(
  requestContext: Pick<RequestContext, "rules" | "agentSkills">,
  actorIdentity: RequestContextResolveOptions["actorIdentity"],
): boolean {
  const filteredRules = filterByActorIdentity(
    requestContext.rules as unknown as readonly ScopedItem[],
    actorIdentity,
  ) as unknown as RequestContext["rules"]
  const filteredAgentSkills = filterByActorIdentity(
    requestContext.agentSkills as unknown as readonly ScopedItem[],
    actorIdentity,
  ) as unknown as RequestContext["agentSkills"]
  const changed = filteredRules.length !== requestContext.rules.length ||
    filteredAgentSkills.length !== requestContext.agentSkills.length
  requestContext.rules = filteredRules
  requestContext.agentSkills = filteredAgentSkills
  return changed
}

export async function resolveRequestContext({ parentCtx, maybeRequestContext, resources, options }: {
  readonly parentCtx: Context
  readonly maybeRequestContext?: RequestContext
  readonly resources: RequestContextResources
  readonly options?: RequestContextResolveOptions
}): Promise<{ readonly requestContext: RequestContext; readonly provenance: RequestContextProvenance }> {
  using span = createSpan(parentCtx.withName("getRequestContext"))
  const ctx = span.ctx

  /** Points the notes folders at this session; says whether anything changed. */
  const applyAgentNotesFolderOverrides = (requestContext: RequestContext): boolean => {
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
  const requestContextArgs = options?.notesSessionId === undefined
    ? new RequestContextArgs()
    : new RequestContextArgs({ notesSessionId: options.notesSessionId })
  const requestContextResult = await requestContextExecutor.execute(ctx, requestContextArgs)
  if (requestContextResult.result.case !== "success") throw new Error("Failed to get request context")
  const requestContext = requestContextResult.result.value.requestContext
  if (requestContext === undefined) throw new Error("Failed to get request context")
  applyAgentNotesFolderOverrides(requestContext)
  filterRequestContextByActorIdentity(requestContext, options?.actorIdentity)
  return { requestContext, provenance: "executorFetched" }
}

export async function getRequestContext(
  parentCtx: Context,
  maybeRequestContext: RequestContext | undefined,
  resources: RequestContextResources,
  options?: RequestContextResolveOptions,
): Promise<RequestContext> {
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
    maybeRequestContext === undefined
      ? undefined
      : (fromRedactedRequestContext as unknown as (
        msg: RedactedRequestContext,
        purpose: PrivacyCapability,
        opts?: unknown,
      ) => RequestContext)(maybeRequestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    resources,
    options,
  )
  return toRedactedRequestContext(unredacted, maybeRequestContext?._privacyMode ?? PrivacyMode.UNSPECIFIED)
}

/**
 * Where a plan's file is, and what to do when it is not where it was.
 *
 * A plan lives in a file so the user can read and edit it, and the turn that executes the plan is given the
 * path. That path can be wrong by the time the plan is executed: the file may have been deleted, or the
 * path may have been built on another machine with another separator. So the path is checked rather than
 * trusted — the file is probed for existence — and if it is not there the plan is written again from the
 * content the turn already holds, into the session's artifacts folder, under a name taken from the original
 * path or from the plan's own identifier.
 *
 * Which of those happened is reported rather than assumed, because the caller has to decide whether to
 * register the plan: a plan that was found on disk or written again should be registered, and one that
 * could not be resolved at all should not be, so a registry entry never points at a file that does not
 * exist. A name taken from a path is sanitised first, since it becomes a filename in a folder the platform
 * owns.
 */

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/index.ts"
import { readExecutorResource } from "../../agent-exec/read-operation.ts"
import { writeExecutorResource } from "../../agent-exec/write-operation.ts"
import { ReadArgs } from "../../proto/generated/agent/v1/read_exec_pb.ts"
import { WriteArgs } from "../../proto/generated/agent/v1/write_exec_pb.ts"
import { PrivacyCapability } from "../../redaction/classification.ts"
import { getRequestPathModule } from "../utils/request-paths.ts"

type Any = any

const logger = createLogger("@slate/agent:execute-plan")

export interface ExecutePlanPlanFileAction {
  readonly planFilePath?: { unwrap(purpose: PrivacyCapability): string } | undefined
  readonly planId?: string | undefined
}

export interface ExecutePlanPlanFileRequestContext {
  readonly env?: {
    readonly artifactsFolder?: string | undefined
    readonly osVersion?: string | undefined
  } | undefined
}

export interface ExecutePlanPlanFileResourceAccessor {
  get(resource: typeof readExecutorResource): {
    execute(ctx: Context, args: ReadArgs): Promise<Any>
  }
  get(resource: typeof writeExecutorResource): {
    execute(ctx: Context, args: WriteArgs): Promise<Any>
  }
}

export interface ExecutePlanPlanFileResolution {
  readonly planFilePath: string | undefined
  readonly recreatedPlanFilePath: string | undefined
  readonly shouldUpsertPlanRegistryEntry: boolean
  readonly availability: "unknown" | "on_disk" | "unavailable"
}

/** A filename taken from a path the user may have chosen, made safe to write. */
export function sanitizePlanFileName(candidate: string): string | undefined {
  const lastSegment = candidate.split(/[/\\]/).pop() ?? ""
  const sanitized = lastSegment.replace(/[^A-Za-z0-9._-]/g, "_")
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return undefined
  }
  return sanitized
}

export async function resolvePlanFilePath(
  ctx: Context,
  requestContext: ExecutePlanPlanFileRequestContext,
  resourceAccessor: ExecutePlanPlanFileResourceAccessor,
  action: ExecutePlanPlanFileAction,
  planFileContent: string,
): Promise<ExecutePlanPlanFileResolution> {
  const providedPlanFilePath = action.planFilePath?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) || undefined
  const artifactsFolder = requestContext.env?.artifactsFolder
  // With nowhere to write, the path the turn was given is all there is to go on.
  if (artifactsFolder === undefined || artifactsFolder.length === 0) {
    return {
      planFilePath: providedPlanFilePath,
      recreatedPlanFilePath: undefined,
      shouldUpsertPlanRegistryEntry: false,
      availability: "unknown",
    }
  }

  let readResultCase: string | undefined
  try {
    if (providedPlanFilePath !== undefined) {
      const readResult = await resourceAccessor.get(readExecutorResource).execute(
        ctx,
        // One line is enough to learn whether the file is there; the plan itself is already in memory.
        new ReadArgs({ path: providedPlanFilePath, limit: 1 }),
      )
      readResultCase = readResult.result.case
      if (readResult.result.case === "success") {
        return {
          planFilePath: providedPlanFilePath,
          recreatedPlanFilePath: undefined,
          shouldUpsertPlanRegistryEntry: true,
          availability: "on_disk",
        }
      }
    }

    // The path module follows the session's platform, since the path was built there.
    const pathModule = getRequestPathModule(
      requestContext.env?.osVersion === undefined
        ? {}
        : { env: { osVersion: requestContext.env.osVersion } },
    )
    const fallbackFileName =
      (providedPlanFilePath !== undefined
        ? sanitizePlanFileName(providedPlanFilePath)
        : undefined) ??
      (action.planId !== undefined
        ? sanitizePlanFileName(`${action.planId}.plan.md`)
        : undefined) ??
      "plan.md"
    const recreatedPlanFilePath = pathModule.join(
      artifactsFolder,
      "plans",
      fallbackFileName,
    )
    const writeResult = await resourceAccessor.get(writeExecutorResource).execute(
      ctx,
      new WriteArgs({
        path: recreatedPlanFilePath,
        fileText: planFileContent,
        returnFileContentAfterWrite: false,
      }),
    )
    if (writeResult.result.case !== "success") {
      logger.warn(ctx, "agent.execute_plan.plan_file_recreate_failed", {
        planId: action.planId,
        hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
        readResultCase,
        writeResultCase: writeResult.result.case,
      })
      return {
        planFilePath: providedPlanFilePath,
        recreatedPlanFilePath: undefined,
        shouldUpsertPlanRegistryEntry: false,
        availability: "unavailable",
      }
    }
    logger.info(ctx, "agent.execute_plan.plan_file_recreated", {
      planId: action.planId,
      hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
      readResultCase,
    })
    return {
      planFilePath: recreatedPlanFilePath,
      recreatedPlanFilePath,
      shouldUpsertPlanRegistryEntry: true,
      availability: "on_disk",
    }
  } catch (error) {
    logger.error(ctx, "agent.execute_plan.plan_file_resolution_failed", error, {
      planId: action.planId,
      hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
      readResultCase,
    })
    return {
      planFilePath: providedPlanFilePath,
      recreatedPlanFilePath: undefined,
      shouldUpsertPlanRegistryEntry: false,
      availability: "unavailable",
    }
  }
}

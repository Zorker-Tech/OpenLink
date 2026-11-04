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
import { getRequestPathModule } from "../utils/request-paths.ts"
import type { PlanFileReference, ExecutePlanPlanFileIO } from "./execute-plan-contracts.ts"

const logger = createLogger("@slate/agent:execute-plan")

export interface ExecutePlanPlanFileRequestContext {
  readonly env?: {
    readonly artifactsFolder?: string | undefined
    readonly osVersion?: string | undefined
  } | undefined
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
  fileIO: ExecutePlanPlanFileIO,
  action: PlanFileReference,
  planFileContent: string,
): Promise<ExecutePlanPlanFileResolution> {
  const providedPlanFilePath = action.path || undefined
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

  let originalFileExists: boolean | undefined
  try {
    if (providedPlanFilePath !== undefined) {
      originalFileExists = await fileIO.exists(ctx, providedPlanFilePath)
      if (originalFileExists) {
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
      (action.id !== undefined
        ? sanitizePlanFileName(`${action.id}.plan.md`)
        : undefined) ??
      "plan.md"
    const recreatedPlanFilePath = pathModule.join(
      artifactsFolder,
      "plans",
      fallbackFileName,
    )
    const restored = await fileIO.restoreFile(ctx, recreatedPlanFilePath, planFileContent)
    if (!restored) {
      logger.warn(ctx, "agent.execute_plan.plan_file_recreate_failed", {
        planId: action.id,
        hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
        originalFileExists,
      })
      return {
        planFilePath: providedPlanFilePath,
        recreatedPlanFilePath: undefined,
        shouldUpsertPlanRegistryEntry: false,
        availability: "unavailable",
      }
    }
    logger.info(ctx, "agent.execute_plan.plan_file_recreated", {
      planId: action.id,
      hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
      originalFileExists,
    })
    return {
      planFilePath: recreatedPlanFilePath,
      recreatedPlanFilePath,
      shouldUpsertPlanRegistryEntry: true,
      availability: "on_disk",
    }
  } catch (error) {
    logger.error(ctx, "agent.execute_plan.plan_file_resolution_failed", error, {
      planId: action.id,
      hasProvidedPlanFilePath: providedPlanFilePath !== undefined,
      originalFileExists,
    })
    return {
      planFilePath: providedPlanFilePath,
      recreatedPlanFilePath: undefined,
      shouldUpsertPlanRegistryEntry: false,
      availability: "unavailable",
    }
  }
}

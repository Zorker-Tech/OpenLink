/**
 * The tools an agent uses to manage the subagents it started.
 *
 * They list what is running, stop one, and ask one what it is doing — each naming the subagent the way the platform
 * does, so an agent cannot manage something that is not its own.
 */
import { z } from "zod";
import { defineCommunicateTool } from "./communicate-tool.ts";
import type { Context } from "../../../packages/context/context.ts";

export interface RunningSubagentInfo {
  readonly subagentId: string;
  readonly subagentType: string;
  readonly title: string;
  readonly elapsedMs: number;
  readonly toolCallCount: number;
  readonly recentActivity: readonly string[];
  readonly transcriptPath?: string | null;
}

export interface SubagentManagementController<_Context = Context> {
  listRunningSubagents(): readonly RunningSubagentInfo[];
  getRunningSubagent(subagentId: string): RunningSubagentInfo | undefined;
  steerSubagent(subagentId: string, message: string): "steered" | "not-running" | string;
  abortSubagent(subagentId: string): "aborted" | "not-running" | string;
  reviewSteer?(
    context: Context,
    request: { readonly subagentId: string; readonly message: string; readonly toolCallId: string },
  ): Promise<{ readonly allowed: boolean; readonly reason: string }>;
}

export const checkSubagentParameters = z.object({
  subagent_id: z.string().trim().optional().describe(
    "The Agent ID of the subagent to inspect (from the Task tool result that dispatched it). Omit to list every subagent currently running.",
  ),
});

export const messageSubagentParameters = z.object({
  subagent_id: z.string().trim().min(1).describe(
    "The Agent ID of the running subagent to message (from the Task tool result that dispatched it).",
  ),
  message: z.string().trim().min(1).describe(
    "The instruction to inject. The subagent interrupts what it is doing, reads this, and continues from where it was with its context intact.",
  ),
});

export const stopSubagentParameters = z.object({
  subagent_id: z.string().trim().min(1).describe(
    "The Agent ID of the running subagent to abort (from the Task tool result that dispatched it).",
  ),
});

export function elapsedLabel(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1_000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function describeRunningSubagent(
  subagentInfo: RunningSubagentInfo,
  formatOptions: { readonly detailed: boolean },
): string {
  const summaryLine = `- ${subagentInfo.subagentId} [${subagentInfo.subagentType}] "${subagentInfo.title}" — running for ${elapsedLabel(subagentInfo.elapsedMs)}, ${subagentInfo.toolCallCount} tool call(s)`;
  if (!formatOptions.detailed) return summaryLine;
  const outputLines = [summaryLine];
  if (subagentInfo.recentActivity.length > 0) {
    outputLines.push("  Recent activity (oldest → newest):");
    for (const activityLine of subagentInfo.recentActivity) outputLines.push(`    ${activityLine}`);
  } else {
    outputLines.push("  No tool activity recorded yet.");
  }
  if (subagentInfo.transcriptPath != null) {
    outputLines.push(`  Full transcript (read it for the complete play-by-play): ${subagentInfo.transcriptPath}`);
  }
  return outputLines.join("\n");
}

export function notRunningMessage(
  subagentId: string,
  activeSubagents: readonly RunningSubagentInfo[],
): string {
  const introText = `No subagent "${subagentId}" is currently running. It may have already finished (you're revived automatically with a finished subagent's result), or the id is wrong.`;
  return activeSubagents.length === 0
    ? `${introText} No subagents are running right now.`
    : `${introText} Currently running: ${activeSubagents.map((subagentInfo) => subagentInfo.subagentId).join(", ")}.`;
}

export function createSubagentManagementTools(
  management: SubagentManagementController,
) {
  return [
    defineCommunicateTool(management, {
      id: "CHECK_SUBAGENT",
      name: "CheckSubagent",
      description: "Check how a background subagent you dispatched (via Task) is doing without waiting for it to finish. Returns its status, how long it has been running, the tool calls it has made recently, and a path to its live transcript you can Read for the full play-by-play. Pass the subagent's Agent ID (from the Task result), or omit it to list every running subagent. Use this when a subagent — especially a computerUse one driving the box desktop — is taking a long time or might be stuck or looping, so you can decide whether to MessageSubagent it or StopSubagent it. This is read-only; it's not polling for completion (you're revived automatically when a subagent finishes).",
      parameters: checkSubagentParameters,
      async execute(_context, parsedArgs: z.infer<typeof checkSubagentParameters>, capabilities) {
        const id = parsedArgs.subagent_id;
        if (id == null || id.length === 0) {
          const activeSubagents = capabilities.listRunningSubagents();
          if (activeSubagents.length === 0) return "No background subagents are running right now.";
          return [
            `${activeSubagents.length} subagent(s) running:`,
            ...activeSubagents.map((subagentInfo) => describeRunningSubagent(subagentInfo, { detailed: false })),
            "Pass a subagent_id to see its recent activity and transcript path.",
          ].join("\n");
        }
        const subagentInfo = capabilities.getRunningSubagent(id);
        return subagentInfo == null
          ? notRunningMessage(id, capabilities.listRunningSubagents())
          : describeRunningSubagent(subagentInfo, { detailed: true });
      },
    }),
    defineCommunicateTool(management, {
      id: "MESSAGE_SUBAGENT",
      name: "MessageSubagent",
      description: "Force a message into a running background subagent to course-correct it without aborting it. The subagent interrupts its current step, reads your message, and continues from where it was (its context is preserved — it does not start over). Use this to unstick or redirect a subagent that is looping, stuck, or heading the wrong way — for example to tell a computerUse subagent to try a different element, that the user just signed in so it can proceed, or to wrap up and report what it has. Pass the subagent's Agent ID (from the Task result). You're still revived with its result when it finishes; to follow up AFTER a subagent has already finished, use Task with the resume parameter instead.",
      parameters: messageSubagentParameters,
      async execute(context: Context, parsedArgs: z.infer<typeof messageSubagentParameters>, capabilities) {
        if (capabilities.reviewSteer != null) {
          const steerDecision = await capabilities.reviewSteer(context, {
            subagentId: parsedArgs.subagent_id,
            message: parsedArgs.message,
            toolCallId: capabilities.toolCallId,
          });
          if (!steerDecision.allowed) return steerDecision.reason;
        }
        if (capabilities.steerSubagent(parsedArgs.subagent_id, parsedArgs.message) === "not-running") {
          return notRunningMessage(parsedArgs.subagent_id, capabilities.listRunningSubagents());
        }
        return `Message delivered to subagent ${parsedArgs.subagent_id}. It will interrupt what it's doing, take your message into account, and keep working. You'll be revived with its result when it finishes \u2014 don't wait on it.`;
      },
    }),
    defineCommunicateTool(management, {
      id: "STOP_SUBAGENT",
      name: "StopSubagent",
      description: "Abort a running background subagent you dispatched (via Task). Use this to kill a subagent that is wedged, looping with no progress, or no longer needed — for example a computerUse subagent stuck on the box desktop. This tears the subagent down and frees its box desktop window; it does not come back, and you are not separately revived for it (this tool's result is the confirmation). If you instead want it to change course and keep going, use MessageSubagent. Pass the subagent's Agent ID (from the Task result).",
      parameters: stopSubagentParameters,
      async execute(_context, parsedArgs: z.infer<typeof stopSubagentParameters>, capabilities) {
        if (capabilities.abortSubagent(parsedArgs.subagent_id) === "not-running") {
          return notRunningMessage(parsedArgs.subagent_id, capabilities.listRunningSubagents());
        }
        return `Stopping subagent ${parsedArgs.subagent_id}. It will be torn down and won't report back.`;
      },
    }),
  ];
}

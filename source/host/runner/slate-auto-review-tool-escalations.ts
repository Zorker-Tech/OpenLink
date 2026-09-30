/**
 * Asking a user about a tool call an auto-review would not decide on its own.
 *
 * What the review could not settle is escalated as a question with its own identifier, and the answer is matched back to
 * the call that asked for it — so an agent is not left waiting on a question nobody answered.
 */
import {
  type SlateAutoReviewController,
  type SlateAutoReviewExpiryPolicy,
} from "./slate-auto-review.ts";
import {
  describeSlateMcpAutoReviewAction,
  describeSlateShellAutoReviewAction,
  summarizeSlateMcpAutoReviewAction,
} from "./slate-auto-review-summaries.ts";

export interface ShellApprovalTarget {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly description?: string;
  readonly blockReason: string;
  readonly proposedAllowRule?: string;
}

export interface ShellApprovalRequest {
  readonly target: ShellApprovalTarget;
  readonly fingerprint: string;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}

export function createSlateShellApprovalProvider(args: {
  readonly controller: Pick<SlateAutoReviewController, "requestApproval">;
  readonly agentId: string;
  readonly surface: "host_shell" | "box_shell";
  readonly getExpiryPolicy: () => SlateAutoReviewExpiryPolicy;
  readonly beforeApproval?: (args: {
    readonly toolCallId: string;
    readonly signal?: AbortSignal;
    readonly command: string;
    readonly description?: string;
  }) => Promise<{ readonly allowed: boolean; readonly reason?: string }>;
}) {
  return {
    async requestApproval(request: ShellApprovalRequest) {
      const description = request.target.description?.trim();
      if (args.beforeApproval != null) {
        const prior = await args.beforeApproval({
          toolCallId: request.toolCallId,
          ...(request.signal == null ? {} : { signal: request.signal }),
          command: request.target.command,
          ...(description == null || description.length === 0 ? {} : { description }),
        });
        if (!prior.allowed) {
          return { approved: false as const, reason: prior.reason };
        }
      }
      return args.controller.requestApproval({
        agentId: args.agentId,
        surface: args.surface,
        fingerprint: request.fingerprint,
        reason: request.target.blockReason,
        summary: describeSlateShellAutoReviewAction({
          surface: args.surface,
          ...(request.target.workingDirectory == null
            ? {}
            : { workingDirectory: request.target.workingDirectory }),
          ...(description == null || description.length === 0 ? {} : { description }),
        }),
        command: request.target.command,
        ...(request.target.proposedAllowRule == null
          ? {}
          : { proposedRule: request.target.proposedAllowRule }),
        ...(request.signal == null ? {} : { signal: request.signal }),
        expiryPolicy: args.getExpiryPolicy(),
      });
    },
  };
}

export interface McpApprovalRequest {
  readonly fingerprint: string;
  readonly signal?: AbortSignal;
  readonly target: {
    readonly blockReason: string;
    readonly serverDisplayName: string;
    readonly toolName: string;
    readonly mcpArguments?: unknown;
    readonly description?: string;
    readonly proposedAllowRule?: string;
  };
}

export function createSlateMcpApprovalProvider(args: {
  readonly controller: Pick<SlateAutoReviewController, "requestApproval">;
  readonly agentId: string;
  readonly getExpiryPolicy: () => SlateAutoReviewExpiryPolicy;
}) {
  return {
    requestApproval(request: McpApprovalRequest) {
      const description = request.target.description?.trim();
      return args.controller.requestApproval({
        agentId: args.agentId,
        surface: "mcp",
        fingerprint: request.fingerprint,
        reason: request.target.blockReason,
        summary: describeSlateMcpAutoReviewAction({
          serverDisplayName: request.target.serverDisplayName,
          toolName: request.target.toolName,
          ...(request.target.mcpArguments === undefined
            ? {}
            : { mcpArguments: request.target.mcpArguments }),
          ...(description == null || description.length === 0 ? {} : { description }),
        }),
        command: summarizeSlateMcpAutoReviewAction({
          serverDisplayName: request.target.serverDisplayName,
          toolName: request.target.toolName,
          mcpArguments: request.target.mcpArguments,
        }),
        ...(request.target.proposedAllowRule == null
          ? {}
          : { proposedRule: request.target.proposedAllowRule }),
        ...(request.signal == null ? {} : { signal: request.signal }),
        expiryPolicy: args.getExpiryPolicy(),
      });
    },
  };
}

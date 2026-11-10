import { SLATE_WEBSITE_ORIGIN } from "../transcript/agent-run-error.ts";
import type { DetailedCloudAgent } from "./cloud-agent-poll-loop.ts";
import type { CloudAgentPrState } from "./cloud-agent-manager-contracts.ts";

const RUN_STATUS_NAMES = ["creating", "running", "finished", "error", "expired"] as const;

export function mapRunStatus(status: unknown): string {
  if (typeof status !== "string") {
    return typeof status === "number" && status >= 1 && status <= 5
      ? ["unknown", "running", "finished", "error", "creating", "expired"][status] ?? "unknown"
      : "unknown";
  }

  const normalized = status.toLowerCase();
  return RUN_STATUS_NAMES.includes(normalized as typeof RUN_STATUS_NAMES[number]) ? normalized : "unknown";
}

export function resolvePrUrl(
  detailed?: DetailedCloudAgent & { readonly prs?: readonly { readonly prUrl?: string }[] },
): string {
  return detailed?.agent?.prUrl || detailed?.prs?.find((pullRequest) => pullRequest.prUrl)?.prUrl || "";
}

export function resolveBranchName(
  detailed?: DetailedCloudAgent & { readonly prs?: readonly { readonly branchName?: string }[] },
): string {
  return detailed?.agent?.branchName || detailed?.prs?.find((pullRequest) => pullRequest.branchName)?.branchName || "";
}

export function mapProtoPrStatus(status: unknown): Exclude<CloudAgentPrState, "none" | "unknown"> | null {
  switch (status) {
    case 1:
      return "open";
    case 2:
      return "draft";
    case 3:
      return "merged";
    case 4:
      return "closed";
    default:
      return null;
  }
}

export function resolvePr(
  detailed?: DetailedCloudAgent & {
    readonly agent?: DetailedCloudAgent["agent"] & { readonly prStatus?: unknown };
    readonly prs?: readonly { readonly prUrl?: string; readonly pullNumber?: number; readonly prStatus?: unknown }[];
  },
): { readonly state: CloudAgentPrState; readonly number: number | null } {
  const url = resolvePrUrl(detailed);
  const primary = url.length > 0
    ? detailed?.prs?.find((pullRequest) => pullRequest.prUrl === url)
    : detailed?.prs?.find((pullRequest) =>
      pullRequest.pullNumber != null || mapProtoPrStatus(pullRequest.prStatus) != null);
  const state = mapProtoPrStatus(primary?.prStatus)
    ?? mapProtoPrStatus(detailed?.agent?.prStatus)
    ?? (url.length > 0 || primary != null ? "unknown" : "none");
  return { state, number: primary?.pullNumber ?? null };
}

export function normalizeDiffPath(raw: string): string {
  const path = raw.trim();
  return path === "/dev/null" ? "" : path;
}

export function toFileChange(diff: { readonly from: string; readonly to: string; readonly added: number; readonly removed: number }) {
  const previousPath = normalizeDiffPath(diff.from);
  const nextPath = normalizeDiffPath(diff.to);
  const path = nextPath || previousPath;
  return path.length === 0 ? null : { path, added: diff.added, removed: diff.removed };
}

export function cloudAgentUrl(id: string): string {
  return `${SLATE_WEBSITE_ORIGIN}/cloud-agents/${id}`;
}

export function buildTranscriptJsonl(
  conversation: unknown,
  toTraceMessages: (conversation: unknown) => readonly unknown[],
): { readonly jsonl: string; readonly lineCount: number } {
  const lines = toTraceMessages(conversation).map((message) =>
    JSON.stringify(message, (_key, value) => typeof value === "bigint" ? value.toString() : value),
  );
  return { jsonl: lines.length === 0 ? "" : `${lines.join("\n")}\n`, lineCount: lines.length };
}

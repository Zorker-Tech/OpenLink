/** Names and bounded text supplied when a workflow is created or imported. */
import {
  WORKFLOW_MAX_BODY_LENGTH,
  WORKFLOW_MAX_DESCRIPTION_LENGTH,
  WORKFLOW_MAX_NAME_LENGTH,
  type WorkflowSpec,
} from "./workflow-model-contracts.ts";

function singleLineText(input: unknown, limit: number): string {
  if (typeof input !== "string") return "";
  return input.replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function bodyText(input: unknown, limit: number): string {
  return typeof input === "string" ? input.trim().slice(0, limit) : "";
}

export function clampWorkflowName(value: unknown): string {
  return singleLineText(value, WORKFLOW_MAX_NAME_LENGTH);
}

export function clampWorkflowDescription(value: unknown): string {
  return singleLineText(value, WORKFLOW_MAX_DESCRIPTION_LENGTH);
}

export function clampWorkflowBody(value: unknown): string {
  return bodyText(value, WORKFLOW_MAX_BODY_LENGTH);
}

export function slugifyWorkflowName(name: string): string {
  const normalized = name.normalize("NFKD").toLowerCase();
  const parts = normalized.match(/[a-z0-9]+/g) ?? [];
  const slug = parts.join("-").slice(0, 64).replace(/-+$/g, "");
  return slug || "workflow";
}

export function buildLiveSourcePointerBody(source: string): string {
  return [
    `This workflow is a live reference to the skill at \`${source}\`.`,
    "Read that source now with your file or fetch tools and follow it as written. Do not assume its contents from this note; the source is the source of truth and may have changed since this workflow was created.",
  ].join("\n");
}

export function liveWorkflowSpecFromSource(args: { name: string; source: string; description?: string }): WorkflowSpec {
  const source = args.source.trim();
  const name = clampWorkflowName(args.name);
  const explicitDescription = clampWorkflowDescription(args.description ?? "");
  return {
    name,
    description: explicitDescription || clampWorkflowDescription(`Use when the "${name}" skill applies; it is a live reference to ${source}.`),
    body: clampWorkflowBody(buildLiveSourcePointerBody(source)),
    trigger: null,
    sourceRef: source,
  };
}

export function deriveWorkflowNameFromMarkdown(body: string): string | null {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const heading = /^#+\s+(.*)$/.exec(line)?.[1];
    const candidate = (heading ?? line).replace(/[*_`#>]/g, "").trim();
    if (candidate.length > 0) return candidate.slice(0, WORKFLOW_MAX_NAME_LENGTH);
  }
  return null;
}

export function deriveWorkflowNameFromUrl(url: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Keep the supplied value available as a final path-like name.
  }
  const leaf = pathname.split("/").filter(Boolean).at(-1) ?? "Imported skill";
  const withoutExtension = leaf.replace(/\.(md|markdown|mdc|txt)$/i, "");
  const readable = withoutExtension.replace(/[-_]+/g, " ").trim();
  return clampWorkflowName(readable || "Imported skill");
}

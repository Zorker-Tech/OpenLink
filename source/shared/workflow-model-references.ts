/** Workflow references embedded in messages and mentions written into prompts. */
import { WORKFLOW_REFERENCE_NODE_TYPE, type WorkflowRecord } from "./workflow-model-contracts.ts";

interface WorkflowIdentity {
  id: string;
  name: string;
}

interface MentionHandle {
  value: string;
  workflowId: string;
}

interface TextSpan {
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectWorkflowReferences(richText: string | null | undefined): Array<{ id: string; teachQueueScope: string | null }> {
  if (!richText) return [];
  let document: unknown;
  try {
    document = JSON.parse(richText);
  } catch {
    return [];
  }

  const references: Array<{ id: string; teachQueueScope: string | null }> = [];
  const recordedIds = new Set<string>();
  const inspect = (node: unknown): void => {
    if (!isRecord(node)) return;
    const attributes = isRecord(node.attrs) ? node.attrs : undefined;
    const id = attributes?.id;
    if (node.type === WORKFLOW_REFERENCE_NODE_TYPE && typeof id === "string" && id.length > 0 && !recordedIds.has(id)) {
      recordedIds.add(id);
      references.push({ id, teachQueueScope: typeof attributes?.teachQueueScope === "string" ? attributes.teachQueueScope : null });
    }
    if (Array.isArray(node.content)) node.content.forEach(inspect);
  };
  inspect(document);
  return references;
}

function handlesFor(workflow: WorkflowIdentity): string[] {
  const candidates = new Set<string>();
  const name = workflow.name.trim().toLowerCase();
  if (name.length > 0) {
    candidates.add(name);
    candidates.add(name.replace(/\s+/g, ""));
  }
  const id = workflow.id.trim().toLowerCase();
  if (id.length > 0) candidates.add(id);
  return [...candidates];
}

function allHandles(workflows: readonly WorkflowIdentity[]): MentionHandle[] {
  return workflows.flatMap(workflow => handlesFor(workflow).map(value => ({
    value,
    workflowId: workflow.id.toLowerCase(),
  }))).sort((left, right) => right.value.length - left.value.length);
}

function isNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9]/.test(character);
}

function overlaps(span: TextSpan, claimed: readonly TextSpan[]): boolean {
  return claimed.some(existing => span.start < existing.end && existing.start < span.end);
}

function claimAtMentions(prompt: string, handles: readonly MentionHandle[], foundIds: Set<string>): void {
  const foldedPrompt = prompt.toLowerCase();
  const acceptedSpans: TextSpan[] = [];

  for (const handle of handles) {
    const needle = `@${handle.value}`;
    let position = foldedPrompt.indexOf(needle);
    while (position >= 0) {
      const span = { start: position, end: position + needle.length };
      if (!isNameCharacter(foldedPrompt[position - 1])
        && !isNameCharacter(foldedPrompt[span.end])
        && !overlaps(span, acceptedSpans)) {
        acceptedSpans.push(span);
        foundIds.add(handle.workflowId);
      }
      position = foldedPrompt.indexOf(needle, position + 1);
    }
  }
}

export function collectMentionedWorkflows<T extends WorkflowIdentity>(prompt: string, workflows: readonly T[]): T[] {
  const foundIds = new Set<string>();
  const availableById = new Set(workflows.map(workflow => workflow.id.toLowerCase()));
  const references = /slate-workflow:([a-z0-9]+(?:-[a-z0-9]+)*)/gi;
  for (const match of prompt.matchAll(references)) {
    const id = match[1]?.toLowerCase();
    if (id !== undefined && availableById.has(id)) foundIds.add(id);
  }

  claimAtMentions(prompt, allHandles(workflows), foundIds);
  return workflows.filter(workflow => foundIds.has(workflow.id.toLowerCase()));
}

export function promptReferencesWorkflow(prompt: string, workflow: WorkflowIdentity): boolean {
  return collectMentionedWorkflows(prompt, [workflow]).length > 0;
}

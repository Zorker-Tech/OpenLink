import { slugifyWorkflowName } from "../../shared/workflow-model.ts";

/** Choose the first unused folder id for a display name. */
export function nextWorkflowFolderId(name: string, existingIds: readonly string[]): string {
  const base = slugifyWorkflowName(name);
  const existing = new Set(existingIds);
  if (!existing.has(base)) return base;

  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

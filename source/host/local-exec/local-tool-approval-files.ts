import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { parseApproval, type LocalToolApproval } from "./local-tool-approval-contracts.ts";

export async function readLocalToolApprovals(path: string): Promise<Map<string, LocalToolApproval>> {
  try {
    const document = JSON.parse(await fs.readFile(path, "utf8")) as { approvals?: unknown };
    if (!Array.isArray(document?.approvals)) return new Map();

    const byId = new Map<string, LocalToolApproval>();
    for (const value of document.approvals) {
      const approval = parseApproval(value);
      if (approval !== undefined) byId.set(approval.id, approval);
    }
    return byId;
  } catch {
    return new Map();
  }
}

export async function readRetiredApprovalIds(path: string): Promise<Set<string>> {
  try {
    const document = JSON.parse(await fs.readFile(path, "utf8")) as { retiredIds?: unknown };
    const values = Array.isArray(document?.retiredIds) ? document.retiredIds : [];
    return new Set(values.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

export async function writeApprovals(path: string, approvals: Map<string, LocalToolApproval>): Promise<void> {
  if (approvals.size === 0) {
    await fs.rm(path, { force: true });
    return;
  }
  await writeAtomically(path, { approvals: [...approvals.values()] });
}

export async function writeRetiredApprovalIds(path: string, ids: Set<string>): Promise<void> {
  if (ids.size === 0) {
    await fs.rm(path, { force: true });
    return;
  }
  await writeAtomically(path, { retiredIds: [...ids] });
}

export async function readLiveLocalToolApprovals(
  approvalsPath: string,
  retirementsPath: string,
): Promise<Map<string, LocalToolApproval>> {
  const approvals = await readLocalToolApprovals(approvalsPath);
  const retired = await readRetiredApprovalIds(retirementsPath);
  if (retired.size === 0) return approvals;

  const live = new Map(approvals);
  for (const id of retired) live.delete(id);
  return live;
}

async function writeAtomically(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, Buffer.from(JSON.stringify(value)));
  await fs.rename(temporary, path);
}

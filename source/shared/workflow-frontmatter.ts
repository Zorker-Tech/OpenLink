/** Defensive frontmatter parsing and preservation-aware workflow serialization. */
import {
  type ParsedWorkflow,
  type WorkflowSpec,
  type WorkflowTrigger,
} from "./workflow-model-contracts.ts";
import { clampWorkflowBody, clampWorkflowDescription, clampWorkflowName } from "./workflow-model-values.ts";

interface MatterSplit {
  fields: Record<string, unknown>;
  body: string;
}

interface NestingFrame {
  indent: number;
  fields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScalar(source: string): unknown {
  const text = source.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);

  const startsWithQuote = text.startsWith('"') || text.startsWith("'");
  if (startsWithQuote && text.at(-1) === text[0]) {
    if (text.startsWith('"')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function readFields(document: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const path: NestingFrame[] = [{ indent: -1, fields: root }];

  for (const line of document.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const match = /^(\s*)([^:#][^:]*):(?:\s*(.*))?$/.exec(line);
    if (match === null) continue;
    const indent = match[1]?.length ?? 0;
    const key = match[2]?.trim();
    if (key === undefined || key.length === 0) continue;

    while ((path.at(-1)?.indent ?? -1) >= indent) path.pop();
    const parent = path.at(-1)?.fields ?? root;
    const value = match[3] ?? "";
    if (value.trim().length === 0) {
      const nested: Record<string, unknown> = {};
      parent[key] = nested;
      path.push({ indent, fields: nested });
    } else {
      parent[key] = parseScalar(value);
    }
  }
  return root;
}

function splitMatter(source: string): MatterSplit {
  if (!source.startsWith("---")) return { fields: {}, body: source };
  const firstLineEnd = source.indexOf("\n");
  if (firstLineEnd < 0) return { fields: {}, body: source };
  const closingFence = source.indexOf("\n---", firstLineEnd);
  if (closingFence < 0) return { fields: {}, body: source };
  return {
    fields: readFields(source.slice(firstLineEnd + 1, closingFence)),
    body: source.slice(closingFence + 4).replace(/^\r?\n/, ""),
  };
}

function sourceReference(fields: Record<string, unknown>): string | null {
  const metadata = isRecord(fields.metadata) ? fields.metadata : {};
  const raw = typeof metadata.source === "string" ? metadata.source : fields.source;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function triggerFrom(fields: Record<string, unknown>): WorkflowTrigger | null {
  if (!isRecord(fields.trigger)) return null;
  const schedule = typeof fields.trigger.schedule === "string" ? fields.trigger.schedule.trim().replace(/\s+/g, " ") : "";
  if (schedule.length === 0) return null;
  return { schedule, isEnabled: fields.trigger.enabled !== false };
}

export function parseWorkflowFile(raw: string): ParsedWorkflow | null {
  let matter: MatterSplit;
  try {
    matter = splitMatter(raw);
  } catch {
    matter = { fields: {}, body: raw };
  }

  const body = clampWorkflowBody(matter.body);
  if (body.length === 0 && Object.keys(matter.fields).length === 0) return null;
  return {
    name: clampWorkflowName(matter.fields.name),
    description: clampWorkflowDescription(matter.fields.description),
    trigger: triggerFrom(matter.fields),
    body,
    sourceRef: sourceReference(matter.fields),
    data: matter.fields,
  };
}

function encodeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  return JSON.stringify(value);
}

function writeFields(fields: Record<string, unknown>, depth = 0): string[] {
  const output: string[] = [];
  const pad = " ".repeat(depth);
  for (const [key, value] of Object.entries(fields)) {
    if (isRecord(value)) {
      output.push(`${pad}${key}:`);
      output.push(...writeFields(value, depth + 2));
    } else {
      output.push(`${pad}${key}: ${encodeValue(value)}`);
    }
  }
  return output;
}

export function serializeWorkflowFile(spec: WorkflowSpec, existingData: Record<string, unknown> = {}): string {
  const fields: Record<string, unknown> = { ...existingData, name: spec.name };
  if (spec.description.length > 0) fields.description = spec.description;
  else delete fields.description;

  const legacySource = fields.source;
  delete fields.source;
  const metadata = isRecord(fields.metadata) ? { ...fields.metadata } : {};
  const source = spec.sourceRef === undefined ? (metadata.source ?? legacySource) : spec.sourceRef;
  if (typeof source === "string" && source.length > 0) metadata.source = source;
  else delete metadata.source;
  if (Object.keys(metadata).length > 0) fields.metadata = metadata;
  else delete fields.metadata;

  if (spec.trigger !== null) {
    fields.trigger = { schedule: spec.trigger.schedule, enabled: spec.trigger.isEnabled };
  } else {
    delete fields.trigger;
  }

  const body = spec.body.trim();
  return `---\n${writeFields(fields).join("\n")}\n---\n${body}\n`;
}

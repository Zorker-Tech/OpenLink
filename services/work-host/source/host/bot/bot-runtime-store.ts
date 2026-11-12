/**
 * The durable link between a Work-host agent and its Bot execution substrate.
 *
 * Work-host owns the Bot control plane, but it does not own the provider
 * credential that materialises the Bot's OpenSandbox. The binding therefore
 * keeps only what is needed to reach an already provisioned worker: the Bot
 * identity, the Project VM identity, the worker endpoint and its scoped
 * headers. No provider key is written here.
 *
 * The file is per agent, written atomically, and validated on read. A lost or
 * corrupt binding is recoverable: the application projection can call
 * `ensureBotBox` again and the substrate reattaches or recreates the sandbox.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BINDING_FILENAME = "bot-runtime.json";
const BINDING_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface BotRuntimeBinding {
  readonly version: typeof BINDING_VERSION;
  readonly agentId: string;
  readonly botId: string;
  readonly boxKey: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly workerUrl: string;
  readonly workerHeaders: Readonly<Record<string, string>>;
  readonly desktopUrl: string;
  readonly vncUrl: string;
  readonly sandboxId: string | null;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function headerRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const headers: Record<string, string> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof candidate !== "string" || /[\r\n\u0000]/.test(candidate)) return null;
    headers[name] = candidate;
  }
  return headers;
}

/** A binding as the store keeps it, or nothing when the record is not one. */
export function parseBotRuntimeBinding(value: unknown): BotRuntimeBinding | null {
  if (!isRecord(value) || value.version !== BINDING_VERSION) return null;
  const agentId = text(value.agentId);
  const botId = text(value.botId);
  const boxKey = text(value.boxKey);
  const projectId = text(value.projectId);
  const userId = text(value.userId);
  const workspaceId = text(value.workspaceId);
  const workerUrl = text(value.workerUrl);
  const desktopUrl = text(value.desktopUrl);
  const vncUrl = text(value.vncUrl);
  const workerHeaders = headerRecord(value.workerHeaders);
  const updatedAt = text(value.updatedAt);
  if (
    agentId === null || !SAFE_ID.test(agentId)
    || botId === null || !SAFE_ID.test(botId)
    || boxKey === null || !/^bot-[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(boxKey)
    || projectId === null
    || userId === null
    || workspaceId === null
    || workerUrl === null
    || desktopUrl === null
    || vncUrl === null
    || workerHeaders === null
    || updatedAt === null
  ) return null;
  const sandboxId = value.sandboxId === null || value.sandboxId === undefined ? null : text(value.sandboxId);
  if (value.sandboxId !== null && value.sandboxId !== undefined && sandboxId === null) return null;
  return {
    version: BINDING_VERSION,
    agentId,
    botId,
    boxKey,
    projectId,
    userId,
    workspaceId,
    workerUrl,
    workerHeaders,
    desktopUrl,
    vncUrl,
    sandboxId,
    updatedAt,
  };
}

/**
 * The binding directory is the agents root: one file beside each agent, so a
 * Work-host data-root restore restores the Bot links with the agent stores.
 */
export class BotRuntimeStore {
  constructor(readonly rootDir: string) {}

  private pathFor(agentId: string): string {
    if (!SAFE_ID.test(agentId)) throw new Error(`invalid Bot agent id: ${agentId}`);
    return join(this.rootDir, agentId, BINDING_FILENAME);
  }

  read(agentId: string): BotRuntimeBinding | null {
    if (!SAFE_ID.test(agentId)) return null;
    try {
      return parseBotRuntimeBinding(JSON.parse(readFileSync(this.pathFor(agentId), "utf8")));
    } catch {
      return null;
    }
  }

  write(binding: BotRuntimeBinding): void {
    const path = this.pathFor(binding.agentId);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }

  remove(agentId: string): void {
    if (!SAFE_ID.test(agentId)) return;
    rmSync(this.pathFor(agentId), { force: true });
  }

  /** Every valid binding, for startup recovery and health reporting. */
  list(): BotRuntimeBinding[] {
    let entries: string[];
    try {
      entries = readdirSync(this.rootDir);
    } catch {
      return [];
    }
    const bindings: BotRuntimeBinding[] = [];
    for (const agentId of entries) {
      const binding = this.read(agentId);
      if (binding !== null) bindings.push(binding);
    }
    return bindings;
  }
}

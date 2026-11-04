/** Writes and removes memories from the agent, shared-user, or joined-project shard. */
import { FileMemoryStore, getProjectMemoryShardDir, getUserMemoryShardDir, projectDirExists } from "./memory-service.ts";
import { isSafeFolderId } from "../storage/folder-id.ts";
import { normalizeMemoryContent } from "../runner/slate-memory.ts";
import { MEMORY_NOTE_PREFIX, isBlankAgentText, stateWriteFailed, stateWriteOk, type AgentStateDeps, type AgentStateMemoryPort } from "./agent-state-contracts.ts";

const immediateDebounce = {
  name: "slate-agent-state-memory-shard",
  wrap: <Handler extends (...args: never[]) => unknown>(handler: Handler) => Object.assign(handler, { dispose() {} }),
};

interface MemoryShard {
  store: AgentStateMemoryPort;
  label: string;
}

function memoryShard(deps: AgentStateDeps, scope: "agent" | "user" | "project", project?: string): MemoryShard | ReturnType<typeof stateWriteFailed> {
  if (scope === "agent") return { store: deps.memory, label: "your memory" };
  if (scope === "user") {
    return {
      store: new FileMemoryStore(getUserMemoryShardDir(deps.slateRoot, deps.agentId), immediateDebounce),
      label: "shared user memory",
    };
  }

  if (isBlankAgentText(project)) return stateWriteFailed("'project' (the slug) is required when scope is project.");
  const slug = project?.trim() ?? "";
  if (!isSafeFolderId(slug)) return stateWriteFailed(`"${slug}" is not a valid project slug — use a short kebab-case id.`);
  if (!projectDirExists(deps.slateRoot, slug)) return stateWriteFailed(`no project "${slug}" exists yet. Create or join it first (target "project").`);
  if (!deps.membership.read().has(slug)) return stateWriteFailed(`you haven't joined project "${slug}" yet. Join it first (target "project", action "join").`);
  return {
    store: new FileMemoryStore(getProjectMemoryShardDir(deps.slateRoot, slug, deps.agentId), immediateDebounce),
    label: `project "${slug}" memory`,
  };
}

function saveMemory(store: AgentStateMemoryPort, content: string, tier: "profile" | "note" | "log", now: number, label: string) {
  const submitted = tier === "note" ? `${MEMORY_NOTE_PREFIX}${content.trim()}` : content;
  const memory = store.addMemory(submitted, now, tier === "profile" ? "profile" : "log");
  if (memory === null) return stateWriteFailed(`nothing was saved to ${label} — the fact was empty or already recorded. Grep the memory folder to see what is already there.`);
  return stateWriteOk(`Remembered in ${label} (${tier}): ${memory.content}`);
}

export function createAgentMemoryOperations(deps: AgentStateDeps, now: () => number) {
  return {
    async writeMemory(args: { content: string; tier: "profile" | "note" | "log"; scope?: "agent" | "user" | "project"; project?: string }) {
      const shard = memoryShard(deps, args.scope ?? "agent", args.project);
      return "ok" in shard ? shard : saveMemory(shard.store, args.content, args.tier, now(), shard.label);
    },
    async removeMemory(args: { content: string; scope?: "agent" | "user" | "project"; project?: string }) {
      const shard = memoryShard(deps, args.scope ?? "agent", args.project);
      if ("ok" in shard) return shard;
      if (shard.store.removeMemoryByContent(args.content)) {
        return stateWriteOk(`Forgot from ${shard.label}: ${normalizeMemoryContent(args.content)}`);
      }
      return stateWriteFailed(`no fact with exactly that text is recorded in ${shard.label}. Read or grep the folder for the exact wording first.`);
    },
  };
}

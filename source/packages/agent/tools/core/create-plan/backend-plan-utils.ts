/**
 * Keeping a plan file's own todo list in step with the conversation's.
 *
 * A plan is written as a file with a todo list in its frontmatter, and the conversation has a todo list of
 * its own. The two are the same list seen from two places, so when one changes the other has to be updated:
 * the file is read, its frontmatter's todos — at the top level or inside phases — have their statuses
 * replaced with the conversation's, and the file is written again through the same write path as any other
 * edit, which is what makes the change visible to the platform and to the user as an edit rather than a
 * silent rewrite.
 *
 * Everything about this is best-effort, because it is bookkeeping that runs beside the work. A plan whose
 * file is gone, whose frontmatter does not parse, or that has no todos to update is left alone; a status
 * that already matches is not written; and content that would not change is not written either, since a
 * write that changes nothing is still a write the user sees. A failure to read or write is logged rather
 * than raised, because failing the turn over a todo status would be worse than a stale one.
 *
 * A large diff is computed off the main thread, because a plan can be big and the turn should not wait for
 * a diff nobody asked to see. The pool is created once and its threads are half the machine's, since the
 * diff is background work rather than the work.
 */

import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import grayMatter from "gray-matter"
import { Piscina } from "piscina"
import yaml from "js-yaml"
import { z } from "zod"

import { readExecutorResource } from "../../../../agent-exec/read-operation.ts"
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../../agent-exec/executor-resources.ts"
import type { Context } from "../../../../context/context.ts"
import { createLogger } from "../../../../context/index.ts"
import { PrivacyCapability } from "../../../../redaction/classification.ts"
import { fromRedactedTodoItem } from "../../../../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { PlanRegistryEntry } from "../../../../proto/generated/agent/v1/agent_pb.ts"
import { ReadArgs } from "../../../../proto/generated/agent/v1/read_exec_pb.ts"
import { performWrite } from "../edit/common.ts"
import { calculateDiff, type DiffWorkerInput, type DiffWorkerResult } from "../edit/diff-worker.ts"
import { resolveWorkerLocation } from "../worker-script-location.ts"
import { generateSeededUuid } from "../../tool-support.ts"
import { todoStatusToString } from "../todo/common.ts"

const planLog = createLogger("@slate/agent:backend-plan-utils");

export const planTodoFrontmatterSchema = z.object({
  id: z.string(),
  status: z.unknown().optional(),
}).passthrough();

export const planPhaseFrontmatterSchema = z.object({
  todos: z.array(z.unknown()).optional(),
}).passthrough();

export const planFrontmatterSchema = z.object({
  todos: z.array(z.unknown()).optional(),
  phases: z.array(z.unknown()).optional(),
}).passthrough();

const frontmatterDumpOptions: Parameters<typeof yaml.dump>[1] = {
  indent: 2,
  lineWidth: -1,
};

export function stringifyPlanFrontmatter(
  content: string,
  data: Record<string, unknown>,
): string {
  const frontmatter = yaml.dump(data, frontmatterDumpOptions).trim();
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
  if (frontmatter === "{}") return normalizedContent;
  return `---\n${frontmatter}\n---\n${normalizedContent}`;
}

export interface PlanRegistryState {
  readonly plans: ReadonlyMap<string, PlanRegistryEntry>;
}

export function getLatestPlanRegistryEntry(
  stateHandler: PlanRegistryState,
): PlanRegistryEntry | undefined {
  let latestEntry: PlanRegistryEntry | undefined;
  for (const entry of stateHandler.plans.values()) {
    latestEntry = entry;
  }
  return latestEntry;
}

export interface TodoStateReference {
  get(ctx: Context): Promise<Parameters<typeof fromRedactedTodoItem>[0]>;
}

export interface TodoStateForPlanSync {
  readonly todos: readonly TodoStateReference[];
}

export async function buildTodoStatusMap(
  ctx: Context,
  stateHandler: TodoStateForPlanSync,
): Promise<ReadonlyMap<string, string>> {
  const statusMap = new Map<string, string>();
  for (const todoReference of stateHandler.todos) {
    const todo = fromRedactedTodoItem(
      await todoReference.get(ctx),
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      undefined,
    );
    statusMap.set(todo.id, todoStatusToString(todo.status));
  }
  return statusMap;
}

export function updateTodoStatusArray(
  todos: readonly unknown[],
  statusMap: ReadonlyMap<string, string>,
): { readonly didUpdate: boolean; readonly updatedTodos: unknown[] } {
  let changed = false;
  const nextTodos = todos.map(todo => {
    const parsedTodo = planTodoFrontmatterSchema.safeParse(todo);
    if (!parsedTodo.success) return todo;
    const nextStatus = statusMap.get(parsedTodo.data.id);
    if (nextStatus === undefined || parsedTodo.data.status === nextStatus) return todo;
    changed = true;
    return { ...parsedTodo.data, status: nextStatus };
  });
  return { didUpdate: changed, updatedTodos: nextTodos };
}

export interface PlanSyncStateHandler extends TodoStateForPlanSync, PlanRegistryState {
  readonly mode: Parameters<typeof import("../edit/plan-mode-file-policy.ts").assertPlanModeAllowsFileEdit>[1]["mode"];
  setTodos(todos: readonly unknown[]): void;
  recordFileState(path: string, content: string | undefined, previousContent: string | undefined): void;
}

const DIFF_BYTES_THRESHOLD = 256 * 1024;
const workerModuleAddress = typeof __filename === "string"
  ? pathToFileURL(__filename).href
  : import.meta.url;
const { dir: workerDir, extension: workerExtension } = resolveWorkerLocation(workerModuleAddress, "diff-worker");
const workerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "NSOLID_STATSD" && value !== undefined));
let diffPool: Piscina | undefined;

function diffWorkerPool(): Piscina {
  if (diffPool === undefined) {
    const threads = Math.max(1, Math.floor(os.availableParallelism() / 2));
    diffPool = new Piscina({
      minThreads: threads,
      maxThreads: threads,
      ...(workerExtension === "ts" ? { execArgv: ["--experimental-strip-types"] } : {}),
      env: workerEnvironment,
    });
  }
  return diffPool;
}

async function diffStringFor(input: DiffWorkerInput): Promise<DiffWorkerResult> {
  const totalSize = input.original.length + input.new.length;
  if (totalSize > DIFF_BYTES_THRESHOLD) {
    return await diffWorkerPool().run(input, {
      filename: path.join(workerDir, `./diff-worker.${workerExtension}`),
    }) as DiffWorkerResult;
  }
  return calculateDiff(input);
}

function stringifyWithArtifacts(content: string, data: Record<string, unknown>): string {
  return grayMatter.stringify(content, data);
}

export async function syncLatestPlanTodosToFile(request: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly stateHandler: PlanSyncStateHandler;
  readonly toolCallId: string;
}): Promise<void> {
  const { ctx, resourceAccessor, stateHandler, toolCallId } = request;
  const latestEntry = getLatestPlanRegistryEntry(stateHandler);
  if (latestEntry?.path === undefined || latestEntry.path.length === 0) return;
  const statusMap = await buildTodoStatusMap(ctx, stateHandler);
  if (statusMap.size === 0) return;
  try {
    const readExecutor = resourceAccessor.get(readExecutorResource);
    const readResult = await readExecutor.execute(ctx, new ReadArgs({ path: latestEntry.path, toolCallId }), {
      execId: generateSeededUuid(`${toolCallId}-sync-plan-read`),
    });
    if (readResult.result.case !== "success") {
      planLog.warn(ctx, "Failed to read latest plan file while syncing todos", { planPath: latestEntry.path, resultCase: readResult.result.case });
      return;
    }
    if (readResult.result.value.output.case !== "content") {
      planLog.warn(ctx, "Latest plan file is not readable as text", { planPath: latestEntry.path, outputCase: readResult.result.value.output.case });
      return;
    }
    const sourceText = readResult.result.value.output.value;
    const document = grayMatter(sourceText);
    const frontmatter = planFrontmatterSchema.safeParse(document.data);
    if (!frontmatter.success) return;
    let nextFrontmatter = frontmatter.data;
    let changed = false;
    if (nextFrontmatter.todos !== undefined) {
      const nextTodos = updateTodoStatusArray(nextFrontmatter.todos, statusMap);
      if (nextTodos.didUpdate) {
        nextFrontmatter = { ...nextFrontmatter, todos: nextTodos.updatedTodos };
        changed = true;
      }
    }
    if (nextFrontmatter.phases !== undefined) {
      let phasesChanged = false;
      const nextPhases = nextFrontmatter.phases.map(phase => {
        const phaseData = planPhaseFrontmatterSchema.safeParse(phase);
        if (!phaseData.success || phaseData.data.todos === undefined) return phase;
        const nextTodos = updateTodoStatusArray(phaseData.data.todos, statusMap);
        if (!nextTodos.didUpdate) return phase;
        phasesChanged = true;
        return { ...phaseData.data, todos: nextTodos.updatedTodos };
      });
      if (phasesChanged) {
        nextFrontmatter = { ...nextFrontmatter, phases: nextPhases };
        changed = true;
      }
    }
    if (!changed) return;
    const nextText = stringifyWithArtifacts(document.content, nextFrontmatter);
    if (nextText === sourceText) return;
    const { diffString: patchText, linesAdded: addedLines, linesRemoved: removedLines } = await diffStringFor({ original: sourceText, new: nextText });
    await performWrite(ctx, resourceAccessor, latestEntry.path, nextText, {
      resultForModel: `Synced TODO states to ${latestEntry.path}`,
      linesAdded: addedLines,
      linesRemoved: removedLines,
      diffString: patchText,
      originalContent: sourceText,
    }, { toolCallId }, stateHandler);
  } catch (error) {
    planLog.error(ctx, "Failed to sync latest plan file todos", error, { planPath: latestEntry.path });
  }
}

import { test } from "node:test"
import assert from "node:assert/strict"

import { MockIgnoreService, MockPermissionsService } from "../../source/packages/local-exec/tests/common.ts"
import { isMcpDirectoryPath, parseMcpsPath, scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess } from "../../source/packages/local-exec/mcp-disk-freshness-on-access.ts"
import {
  BackgroundShellManager,
  ConversationOwnerOverrideRegistry,
  CoreBackgroundShell,
  type BackgroundShell,
} from "../../source/packages/local-exec/background-shell-lifecycle.ts"
import { createContext } from "../../source/packages/context/context.ts"

// ---------------------------------------------------------------------------------------------
// The doubles the executor's tests are written against
// ---------------------------------------------------------------------------------------------

test("the doubles allow everything until a test says otherwise", async () => {
  const ignore = new MockIgnoreService()
  assert.equal(await ignore.isIgnoredByAny("/repo/a.ts"), false)
  assert.deepEqual(await ignore.listCursorIgnoreFilesByRoot("/repo"), [])
  assert.deepEqual(await ignore.getRepoBlockExcludeGlobs("/repo"), [])

  const permissions = new MockPermissionsService()
  assert.equal((await permissions.shouldBlockShellCommand({}, "ls", {}, { type: "workspace_readonly" })).kind, "allow")
  // A requested policy is handed back rather than replaced, and one that was not asked for is not invented.
  assert.deepEqual((await permissions.shouldBlockShellCommand({}, "ls", {}, { type: "workspace_readonly" })).policy, { type: "workspace_readonly" })
  assert.deepEqual((await permissions.shouldBlockShellCommand({}, "ls", {})).policy, { type: "insecure_none" })

  // The decision a test is about is the one it replaces.
  permissions.setShouldBlockShellCommand(async () => ({ kind: "blocked" } as never))
  assert.equal((await permissions.shouldBlockShellCommand({}, "rm -rf /", {})).kind, "blocked")
})

// ---------------------------------------------------------------------------------------------
// Keeping the catalog fresh when it is read
// ---------------------------------------------------------------------------------------------

test("a path is inside the catalog when it names it", () => {
  assert.equal(isMcpDirectoryPath(undefined), false)
  assert.equal(isMcpDirectoryPath("/repo/src/a.ts"), false)
  assert.equal(isMcpDirectoryPath("/project/mcps"), true)
  assert.equal(isMcpDirectoryPath("/project/mcps/server/tools/search.json"), true)
  // The separators are normalized, since the same path can be spelled two ways.
  assert.equal(isMcpDirectoryPath("C:\\project\\mcps\\server"), true)
})

test("a catalog path says which project it belongs to and which server it names", () => {
  assert.deepEqual(parseMcpsPath("/project/mcps"), { projectDir: "/project", kind: "mcps_root" })
  assert.deepEqual(parseMcpsPath("/project/mcps/my_server/tools/search.json"), {
    projectDir: "/project",
    kind: "server",
    sanitizedServerFolder: "my_server",
  })
  assert.equal(parseMcpsPath("/project/src/a.ts"), undefined)
})

test("reading the catalog schedules a check, once per burst of reads", async () => {
  const reads: string[] = []
  const readDiskCatalog = async (_projectDir: string, serverIdentifier: string) => {
    reads.push(serverIdentifier)
    return { toolNames: [], toolsDirExists: false }
  }
  const stateAccessor = {
    getState: async () => ({ servers: [{ serverIdentifier: "my_server", tools: [{ toolName: "search" }] }, { serverIdentifier: "other_server", tools: [] }] }),
  }
  const ctx = createContext()

  // A path outside the catalog is not a read of it.
  scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(ctx, stateAccessor as never, "/project/src/a.ts", readDiskCatalog as never)
  // Two reads of the same server inside the debounce are one check, and a different server is its own.
  scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(ctx, stateAccessor as never, "/project/mcps/my_server/tools/a.json", readDiskCatalog as never)
  scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(ctx, stateAccessor as never, "/project/mcps/my_server/tools/b.json", readDiskCatalog as never)
  scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(ctx, stateAccessor as never, "/project/mcps/other_server/tools/a.json", readDiskCatalog as never)

  assert.deepEqual(reads, [])
  await new Promise(resolve => setTimeout(resolve, 2_200))
  assert.deepEqual(reads.sort(), ["my_server", "other_server"])
})

test("reading the catalog's root checks every server the state knows", async () => {
  const reads: string[] = []
  const readDiskCatalog = async (_projectDir: string, serverIdentifier: string) => {
    reads.push(serverIdentifier)
    return { toolNames: [], toolsDirExists: true }
  }
  const stateAccessor = {
    getState: async () => ({ servers: [{ serverIdentifier: "my_server", tools: [] }, { serverIdentifier: "other_server", tools: [] }] }),
  }
  scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(createContext(), stateAccessor as never, "/project/mcps/", readDiskCatalog as never)
  await new Promise(resolve => setTimeout(resolve, 2_200))
  // The servers are checked under the folder names their identifiers are sanitized to.
  assert.deepEqual(reads.sort(), ["my_server", "other_server"])
})

// ---------------------------------------------------------------------------------------------
// A shell that outlives the command that started it
// ---------------------------------------------------------------------------------------------

test("a shell that is disposed is stopped once, and says so afterwards", () => {
  const shell = new CoreBackgroundShell(1_001, new AbortController())
  let aborts = 0
  shell.signal.addEventListener("abort", () => {
    aborts += 1
  })

  assert.equal(shell.isDisposed(), false)
  shell.dispose()
  assert.equal(shell.isDisposed(), true)
  assert.equal(shell.signal.aborted, true)
  shell.dispose()
  assert.equal(aborts, 1)
})

test("whoever waits for a shell's completion is told once", () => {
  const shell = new CoreBackgroundShell(1_002, new AbortController())
  const seen: string[] = []
  shell.onComplete(() => seen.push("first"))
  shell.markCompleted({ exitCode: 0 } as never)
  // A shell completes once: a second completion does not replace the one it already reported.
  shell.markCompleted({ exitCode: 1 } as never)
  assert.deepEqual(seen, ["first"])

  // A listener that arrives after the shell finished is answered straight away, with what it reported.
  let lateCompletion: unknown
  shell.onComplete((completion) => {
    seen.push("late")
    lateCompletion = completion
  })
  assert.deepEqual(seen, ["first", "late"])
  assert.equal((lateCompletion as { exitCode?: number } | undefined)?.exitCode, 0)
})

function createShell(id: number) {
  const shell = new CoreBackgroundShell(id, new AbortController())
  const written: string[] = []
  shell.stdin = {
    write: (data: string, callback?: () => void) => {
      written.push(data)
      callback?.()
      return true
    },
    end: () => {},
  } as unknown as NodeJS.WritableStream
  return { shell, written }
}

function createManager(shells: readonly BackgroundShell[]) {
  const cleared: string[] = []
  const enqueued: Array<Record<string, unknown>> = []
  const registry = {
    enqueue: (wakeup: Record<string, unknown>) => enqueued.push(wakeup),
    upsertWork: () => {},
    clearWork: (id: string) => {
      cleared.push(id)
      return undefined
    },
    abortWork: () => true,
    hasRunningWork: () => false,
    abortAllWork: () => 0,
    listWork: () => [],
    pull: () => [],
    ack: () => [],
    nack: () => {},
    suppress: () => {},
    drainCompletions: () => [],
    hasPendingCompletions: () => false,
    markAwaitedCompletion: () => {},
  }
  let index = 0
  const factory = {
    spawn: async () => shells[index++]!,
    adopt: async () => shells[index++]!,
  }
  return { manager: new BackgroundShellManager(factory as never, registry as never), cleared, enqueued, factory }
}

test("a shell that was started is running, and can be written to and stopped", async () => {
  const { shell, written } = createShell(1_010)
  const { manager, cleared } = createManager([shell])

  const spawned = await manager.spawn({ command: "npm run dev", conversationId: "conversation-1" } as never, undefined)
  assert.equal(spawned.shellId, 1_010)
  assert.equal(manager.isRunning(1_010), true)

  await manager.writeStdin(1_010, "hello\n")
  assert.deepEqual(written, ["hello\n"])

  assert.equal(manager.abort(1_010), true)
  assert.equal(shell.signal.aborted, true)
  assert.equal(manager.isRunning(1_010), false)
  // The work the shell stood for is cleared, since there is no longer anything to come back to.
  assert.equal(cleared.includes("1010"), true)

  // A shell nobody started is not running and cannot be stopped.
  assert.equal(manager.isRunning(999_999), false)
  assert.equal(manager.abort(999_999), false)
})

test("stopping the manager stops every shell it holds", async () => {
  const first = createShell(1_020)
  const second = createShell(1_021)
  const { manager } = createManager([first.shell, second.shell])

  await manager.spawn({ command: "a" } as never, undefined)
  await manager.spawn({ command: "b" } as never, undefined)
  manager.dispose()

  assert.equal(first.shell.signal.aborted, true)
  assert.equal(second.shell.signal.aborted, true)
  assert.equal(manager.isRunning(1_020), false)
  assert.equal(manager.isRunning(1_021), false)
})

test("a shell's completion is handed on as work for its conversation", async () => {
  const { shell } = createShell(1_030)
  const { manager, enqueued } = createManager([shell])

  await manager.spawn({ command: "npm run dev", conversationId: "conversation-1", toolCallId: "call-1", description: "the dev server" } as never, undefined)
  shell.markCompleted({ exitCode: 0 } as never)

  const completion = enqueued.at(-1)
  assert.equal(completion?.conversationId, "conversation-1")
  assert.equal((completion?.payload as { toolCallId?: string } | undefined)?.toolCallId, "call-1")
  assert.equal(manager.isRunning(1_030), false)
})

test("a registry that speaks for one conversation stamps it on what it is given", () => {
  const enqueued: Array<Record<string, unknown>> = []
  const inner = {
    enqueue: (wakeup: Record<string, unknown>) => enqueued.push(wakeup),
    upsertWork: () => {},
    clearWork: () => undefined,
    abortWork: () => false,
    hasRunningWork: () => false,
    abortAllWork: () => 0,
    listWork: () => [],
    pull: () => [],
    ack: () => [],
    nack: () => {},
    suppress: () => {},
    drainCompletions: () => [],
    hasPendingCompletions: () => false,
    markAwaitedCompletion: () => {},
  }
  const registry = new ConversationOwnerOverrideRegistry(inner as never, "conversation-9")

  registry.enqueue({ id: "task-1" })
  assert.deepEqual(enqueued[0], { id: "task-1", conversationId: "conversation-9" })

  // A completion becomes work whose id is the task and whose source is the kind of completion it was.
  registry.enqueueCompletion({ taskId: "task-2", kind: "background-shell", exitCode: 0 })
  assert.equal(enqueued[1]?.conversationId, "conversation-9")
  assert.equal(enqueued[1]?.id, "task-2")
  assert.equal(enqueued[1]?.source, "background-shell")
})

test("these tests leave nothing running behind them", async () => {
  // A test file that leaves a handle behind keeps the runner alive; this reports what is left.
  await new Promise(resolve => setTimeout(resolve, 2_500))
  const leftovers = process.getActiveResourcesInfo().filter(resource => resource !== "PipeWrap")
  assert.deepEqual(leftovers, [])
})

import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import {
  cloneAgentDir,
  cloneAgentDisplayName,
  listAgentAutomationConfigFiles,
  SlateAgentCloneError,
  type AgentCloneAdapters,
} from "../../source/host/agents/agent-clone.ts"
import { agentWorkflowStatePath } from "../../source/host/agents/agent-workflow-enablement.ts"
import { getSlateProfilePath, readSlateProfileFile, writeSlateProfileFile } from "../../source/host/agents/agent-profile.ts"
import { agentSettingsAt, getSlateSettingsPath, writeAgentSettings } from "../../source/host/agents/settings-file.ts"

async function withTemporaryRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "slate-agent-clone-contract-"))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("display names are trimmed and empty names still have a usable copy label", () => {
  assert.equal(cloneAgentDisplayName(" Original "), "Original copy")
  assert.equal(cloneAgentDisplayName("  "), "copy")
})

test("automation discovery only returns immediate folders with a config file", async () => {
  await withTemporaryRoot(async root => {
    const automations = join(root, "automations")
    await mkdir(join(automations, "daily"), { recursive: true })
    await mkdir(join(automations, "empty"), { recursive: true })
    await mkdir(join(automations, "daily", "nested"), { recursive: true })
    await writeFile(join(automations, "daily", "automation.json"), "{\"id\":\"daily\"}")
    await writeFile(join(automations, "daily", "nested", "automation.json"), "{\"id\":\"nested\"}")
    await writeFile(join(automations, "not-a-folder"), "ignored")

    assert.deepEqual(listAgentAutomationConfigFiles(automations).map(({ folderName }) => folderName), ["daily"])
    assert.deepEqual(listAgentAutomationConfigFiles(join(root, "missing")), [])
  })
})

test("a clone copies profile settings workflows and automation configs before changing identity", async () => {
  await withTemporaryRoot(async root => {
    const source = join(root, "source")
    const target = join(root, "copy")
    const sourceAutomations = join(source, "automations")
    await mkdir(join(sourceAutomations, "daily"), { recursive: true })
    await mkdir(join(sourceAutomations, "empty"), { recursive: true })
    await writeFile(join(source, "store.db"), "store bytes")
    writeSlateProfileFile(getSlateProfilePath(source), {
      name: "Original",
      description: "A durable agent",
      title: "Helper",
      avatarShape: "round",
      avatarColor: "blue",
    })
    writeAgentSettings(getSlateSettingsPath(source), { notifyOnAgentUpdates: false, hiddenFromSidebar: true })
    const workflowPath = agentWorkflowStatePath(source)
    await mkdir(dirname(workflowPath), { recursive: true })
    await writeFile(workflowPath, "workflow state")
    await writeFile(join(sourceAutomations, "daily", "automation.json"), "{\"id\":\"daily\"}")
    await writeFile(join(sourceAutomations, "empty", "unrelated.txt"), "no config")

    const calls: unknown[][] = []
    const adapters: AgentCloneAdapters = {
      getAutomationsDir: agentDir => join(agentDir, "automations"),
      checkpointStore: path => calls.push(["checkpoint", path]),
      rewriteIdentity: (targetDir, newAgentId, includesChatHistory) => {
        calls.push(["identity", targetDir, newAgentId, includesChatHistory])
      },
    }

    cloneAgentDir(source, target, "clone-2", "Original copy", adapters)

    assert.equal(await readFile(join(target, "store.db"), "utf8"), "store bytes")
    assert.deepEqual(readSlateProfileFile(getSlateProfilePath(target)), {
      name: "Original copy",
      description: "A durable agent",
      title: "Helper",
      avatarShape: "round",
      avatarColor: "blue",
    })
    assert.deepEqual(agentSettingsAt(getSlateSettingsPath(target)), {
      notifyOnAgentUpdates: false,
      hiddenFromSidebar: false,
    })
    assert.equal(await readFile(agentWorkflowStatePath(target), "utf8"), "workflow state")
    assert.equal(await readFile(join(target, "automations", "daily", "automation.json"), "utf8"), "{\"id\":\"daily\"}")
    assert.equal(existsSync(join(target, "automations", "empty")), false)
    assert.deepEqual(calls, [
      ["checkpoint", join(source, "store.db")],
      ["identity", target, "clone-2", false],
    ])
  })
})

test("a missing store or a failed checkpoint removes the partially created target", async () => {
  await withTemporaryRoot(async root => {
    const target = join(root, "missing-copy")
    const adapters: AgentCloneAdapters = {
      getAutomationsDir: () => join(root, "automations"),
      checkpointStore: () => assert.fail("no store should be checkpointed"),
      rewriteIdentity: () => assert.fail("a missing store cannot be rewritten"),
    }
    assert.throws(() => cloneAgentDir(join(root, "missing"), target, "clone-1", "copy", adapters), SlateAgentCloneError)
    assert.equal(existsSync(target), false)

    const source = join(root, "source")
    const failedTarget = join(root, "failed-copy")
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "store.db"), "store bytes")
    const failsAtCheckpoint: AgentCloneAdapters = {
      ...adapters,
      checkpointStore: () => { throw new Error("checkpoint failed") },
    }
    assert.throws(() => cloneAgentDir(source, failedTarget, "clone-2", "copy", failsAtCheckpoint), /checkpoint failed/)
    assert.equal(existsSync(failedTarget), false)
  })
})

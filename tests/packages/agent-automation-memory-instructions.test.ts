import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AUTOMATION_MEMORY_INSTRUCTION_MARKER,
  automationToolNameToSnakeCase,
  materializeAutomationMemoryInstruction,
} from "../../source/packages/agent/prompts/bug_report/automations.ts"
import { adaptMountedAgentStoresForAutomationMemory } from "../../source/adapters/interop/agent/automation-memory-mount-adapter.ts"
import { AGENT_STORE_AUTOMATION_MOUNT_NAME } from "../../source/packages/constants/agent-store-ids.ts"
import {
  MountedAgentStore,
  MountedAgentStoreKind,
} from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts"

test("tool names convert acronym and word boundaries consistently", () => {
  assert.equal(automationToolNameToSnakeCase("readFile"), "read_file")
  assert.equal(automationToolNameToSnakeCase("HTTPServer"), "http_server")
  assert.equal(automationToolNameToSnakeCase("readURL2File"), "read_url2_file")
  assert.equal(automationToolNameToSnakeCase("Already_Snake"), "already_snake")
})

test("instructions without a marker pass through unchanged", () => {
  const original = "Run this task from the provided context."
  assert.equal(materializeAutomationMemoryInstruction(original, []), original)
})

test("the automation principal mount becomes its own memories directory", () => {
  const stores = adaptMountedAgentStoresForAutomationMemory([
    new MountedAgentStore({
      path: "/profiles/user",
      kind: MountedAgentStoreKind.PRINCIPAL,
      alias: AGENT_STORE_AUTOMATION_MOUNT_NAME,
    }),
    new MountedAgentStore({
      path: "/profiles/self",
      kind: MountedAgentStoreKind.SELF,
      alias: AGENT_STORE_AUTOMATION_MOUNT_NAME,
    }),
    new MountedAgentStore({
      path: "/profiles/other",
      kind: MountedAgentStoreKind.PRINCIPAL,
      alias: "another-store",
    }),
  ])
  assert.deepEqual(stores, [
    { alias: AGENT_STORE_AUTOMATION_MOUNT_NAME, path: "/profiles/user" },
    { alias: "another-store", path: "/profiles/other" },
  ])

  const prompt = materializeAutomationMemoryInstruction(AUTOMATION_MEMORY_INSTRUCTION_MARKER, stores)
  assert.match(prompt, /this automation's durable notes under \/profiles\/user\/memories/)
  assert.match(prompt, /use the regular file tools/)
  assert.match(prompt, /MEMORIES\.md/)
  assert.match(prompt, /Read the latest contents before replacing a file/)
  assert.doesNotMatch(prompt, new RegExp(AUTOMATION_MEMORY_INSTRUCTION_MARKER))
})

test("Windows mount paths use Windows joins", () => {
  const prompt = materializeAutomationMemoryInstruction(AUTOMATION_MEMORY_INSTRUCTION_MARKER, [
    { alias: AGENT_STORE_AUTOMATION_MOUNT_NAME, path: "C:\\agent\\stores\\automation" },
  ])
  assert.equal(prompt.includes("C:\\agent\\stores\\automation\\memories"), true)
  assert.match(prompt, /MEMORIES\.md/)
})

test("all markers are replaced and an absent store is handled explicitly", () => {
  const repeated = materializeAutomationMemoryInstruction(
    `${AUTOMATION_MEMORY_INSTRUCTION_MARKER}\n${AUTOMATION_MEMORY_INSTRUCTION_MARKER}`,
    [{ alias: AGENT_STORE_AUTOMATION_MOUNT_NAME, path: "  /automation  " }],
  )
  assert.equal((repeated.match(/automation's durable notes/g) ?? []).length, 2)
  assert.doesNotMatch(repeated, /  \/automation  /)

  const unavailable = materializeAutomationMemoryInstruction(AUTOMATION_MEMORY_INSTRUCTION_MARKER, [])
  assert.match(unavailable, /No automation memory store is mounted/)
  assert.match(unavailable, /Do not read or write memory files/)
})

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  AGENT_STORE_AUTOMATION_MOUNT_NAME,
  AGENT_STORE_TEAM_MOUNT_NAME,
  AGENT_STORE_USER_MOUNT_NAME,
  NAMED_AGENT_HOME_STORE_MOUNT_NAME,
} from "../../source/packages/constants/agent-store-ids.ts"
import { MountedAgentStoresSection } from "../../source/packages/agent/prompts/mounted-stores-section.ts"
import { mountedStoresSection } from "../../source/packages/agent/prompts/user-info-section-parts.ts"
import type { UserInfoEnvironment, UserInfoMountedStore } from "../../source/packages/agent/prompts/user-info-data-contracts.ts"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"

function userInfoEnvironment(stores?: readonly UserInfoMountedStore[]): UserInfoEnvironment {
  return { osVersion: "test-os", workspacePaths: [], mountedAgentStores: stores }
}

describe("mounted agent store instructions", () => {
  it("labels known store identities, preserves order, and leaves unknown identities as paths", () => {
    const stores: readonly UserInfoMountedStore[] = [
      { path: "/stores/self", kind: "self", readOnly: false },
      { path: "/stores/user", kind: "principal", alias: AGENT_STORE_USER_MOUNT_NAME, readOnly: false },
      { path: "/stores/team", kind: "principal", alias: AGENT_STORE_TEAM_MOUNT_NAME, readOnly: true },
      { path: "/stores/automation", kind: "principal", alias: AGENT_STORE_AUTOMATION_MOUNT_NAME, readOnly: false },
      { path: "/stores/home", kind: "principal", alias: NAMED_AGENT_HOME_STORE_MOUNT_NAME, readOnly: false },
      { path: "/stores/peer", kind: "peer", alias: "analyst", readOnly: false },
      { path: "/stores/share", kind: "share", alias: "research", readOnly: false },
      { path: "/stores/custom-principal", kind: "principal", alias: "custom", readOnly: false },
      { path: "/stores/unspecified", kind: "unspecified", readOnly: false },
    ]
    const rendered = renderContent(MountedAgentStoresSection({ stores }))

    for (const text of [
      "Current agent's store: /stores/self",
      "User's personal store: /stores/user",
      "Current team's shared store: /stores/team (read-only)",
      "Current automation's shared store: /stores/automation",
      "Current named agent's shared home store: /stores/home",
      'Peer agent store "analyst": /stores/peer',
      'Shared store "research": /stores/share',
      "/stores/custom-principal",
      "/stores/unspecified",
    ]) assert.ok(rendered.includes(text), text)

    const pathsInOrder = stores.map(store => rendered.indexOf(store.path))
    assert.deepEqual(pathsInOrder, [...pathsInOrder].sort((a, b) => a - b))
  })

  it("states the write rule from read-only state and only names the user shortcut when present", () => {
    const readOnly = renderContent(MountedAgentStoresSection({ stores: [
      { path: "/stores/user", kind: "principal", alias: AGENT_STORE_USER_MOUNT_NAME, readOnly: true },
      { path: "/stores/peer", kind: "peer", alias: "analyst", readOnly: false },
    ] }))
    assert.match(readOnly, /Stores marked \(read-only\) must not be written to; all other stores support reads and writes/)
    assert.match(readOnly, /When the user says "my user store" or "my personal store," use \/stores\/user/)
    assert.match(readOnly, /Only use stores listed here; omitted stores are unavailable/)

    const noUserStore = renderContent(MountedAgentStoresSection({ stores: [
      { path: "/stores/peer", kind: "peer", alias: "analyst", readOnly: false },
    ] }))
    assert.match(noUserStore, /Use normal file tools with these absolute paths to read or write store contents/)
    assert.doesNotMatch(noUserStore, /my user store/)
  })

  it("omits the section when no stores were mounted", () => {
    assert.equal(mountedStoresSection(userInfoEnvironment()), undefined)
    assert.equal(mountedStoresSection(userInfoEnvironment([])), undefined)
    assert.ok(mountedStoresSection(userInfoEnvironment([{ path: "/stores/peer", kind: "peer", readOnly: true }])) !== undefined)
  })
})

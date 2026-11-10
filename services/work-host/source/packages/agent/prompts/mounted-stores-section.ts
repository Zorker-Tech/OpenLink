/**
 * What the agent is told about the stores mounted into its workspace.
 *
 * A store is durable memory that outlives the conversation: the user's own, the team's, an
 * automation's, the agent's own home, a peer's, or one shared with it. The agent reaches them with its
 * ordinary file tools, so what it needs is the absolute path of each and whose it is — a path alone
 * would not say whether writing there is appropriate. Read-only stores are marked, because the failure
 * mode otherwise is an agent that writes into a peer's store and reports success.
 */

import {
  AGENT_STORE_AUTOMATION_MOUNT_NAME,
  AGENT_STORE_TEAM_MOUNT_NAME,
  AGENT_STORE_USER_MOUNT_NAME,
  NAMED_AGENT_HOME_STORE_MOUNT_NAME,
} from "../../constants/agent-store-ids.ts"
import { jsx, jsxs } from "../../prompt-jsx/index.ts"
import type { PromptNode } from "../../prompt-jsx/index.ts"
import type { UserInfoMountedStore } from "./user-info-data-contracts.ts"

function describeStore(store: UserInfoMountedStore): string {
  const readOnlySuffix = store.readOnly ? " (read-only)" : ""
  const quotedAlias = store.alias !== undefined && store.alias.length > 0 ? ` "${store.alias}"` : ""
  switch (store.kind) {
    case "self":
      return `Current agent's store: ${store.path}${readOnlySuffix}`
    case "principal":
      switch (store.alias) {
        case AGENT_STORE_USER_MOUNT_NAME:
          return `User's personal store: ${store.path}${readOnlySuffix}`
        case AGENT_STORE_TEAM_MOUNT_NAME:
          return `Current team's shared store: ${store.path}${readOnlySuffix}`
        case AGENT_STORE_AUTOMATION_MOUNT_NAME:
          return `Current automation's shared store: ${store.path}${readOnlySuffix}`
        case NAMED_AGENT_HOME_STORE_MOUNT_NAME:
          return `Current named agent's shared home store: ${store.path}${readOnlySuffix}`
        default:
          return `${store.path}${readOnlySuffix}`
      }
    case "peer":
      return `Peer agent store${quotedAlias}: ${store.path}${readOnlySuffix}`
    case "share":
      return `Shared store${quotedAlias}: ${store.path}${readOnlySuffix}`
    default:
      return `${store.path}${readOnlySuffix}`
  }
}

export function MountedAgentStoresSection({ stores }: { readonly stores: readonly UserInfoMountedStore[] }): PromptNode {
  const userStore = stores.find(store =>
    store.kind === "principal" && store.alias === AGENT_STORE_USER_MOUNT_NAME)
  const hasReadOnlyStores = stores.some(store => store.readOnly)
  return jsxs("p", {
    children: [
      "Available persistent agent stores:",
      jsx("br", {}),
      stores.map(store => `- ${describeStore(store)}`).join("\n"),
      jsx("br", {}),
      hasReadOnlyStores
        ? "Use normal file tools with these absolute paths. Stores marked (read-only) must not be written to; all other stores support reads and writes. "
        : "Use normal file tools with these absolute paths to read or write store contents. ",
      userStore !== undefined && `When the user says "my user store" or "my personal store," use ${userStore.path}. `,
      "Only use stores listed here; omitted stores are unavailable.",
    ],
  })
}

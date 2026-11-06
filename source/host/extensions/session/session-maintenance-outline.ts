import {
  deriveOutlineFromSlateConversation,
  deriveOutlineTurnsFromSlateConversation,
  type OutlineItem as SessionOutlineItem,
} from "../../runner/conversation-outline.ts"
import type { SlateHydratedConversation } from "../../../packages/agent/conversation-transcript-state.ts"
import type { OutlineItem as MaintenanceOutlineItem } from "./conversation-recovery-contracts.ts"

function maintenanceItem(item: SessionOutlineItem): MaintenanceOutlineItem | undefined {
  switch (item.kind) {
    case "user":
      return {
        kind: "user",
        id: item.id,
        text: item.text,
        ...(item.hidden === true ? { hidden: true } : {}),
      }
    case "send-message":
      return { kind: "send-message", id: item.id, message: item.message }
    case "tool-call":
      return {
        kind: "tool-call",
        id: item.id,
        name: item.name,
        status: item.status,
        ...(item.summary === undefined ? {} : { summary: item.summary }),
      }
    case "assistant-text":
    case "thinking":
      return undefined
  }
}

/** Maintenance keeps the visible message and tool subset used for transcript recovery. */
export function slateMaintenanceOutline(state: SlateHydratedConversation): readonly MaintenanceOutlineItem[] {
  return deriveOutlineFromSlateConversation(state).flatMap(item => {
    const projected = maintenanceItem(item)
    return projected === undefined ? [] : [projected]
  })
}

/** Recovery retains turn grouping while projecting each turn to maintenance's persisted entry set. */
export function slateMaintenanceOutlineTurns(
  state: SlateHydratedConversation,
): readonly { readonly items: readonly MaintenanceOutlineItem[] }[] {
  return deriveOutlineTurnsFromSlateConversation(state).map(turn => ({
    items: turn.items.flatMap(item => {
      const projected = maintenanceItem(item)
      return projected === undefined ? [] : [projected]
    }),
  }))
}

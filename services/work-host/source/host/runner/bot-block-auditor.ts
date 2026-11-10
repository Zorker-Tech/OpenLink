import type { ActionAuditor, AuditRecord } from "./site-visit-tracking.ts";
import { classifyBotBlockPage } from "./bot-block-classifier.ts";
import type { BotBlockHit } from "./bot-block-contracts.ts";

export function withBotBlockDetection(
  auditor: ActionAuditor,
  onHit: (hit: BotBlockHit, record: AuditRecord) => void,
): ActionAuditor {
  return {
    record(record) {
      auditor.record(record);
      const action = record.action;
      if (action.kind !== "browserNavigation" || typeof action.url !== "string") return;
      const hit = classifyBotBlockPage({ url: action.url, title: typeof action.pageTitle === "string" ? action.pageTitle : "" });
      if (hit !== undefined) onHit(hit, record);
    },
  };
}

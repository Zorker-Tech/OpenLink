import type { Executor } from "./agent-store-conflict-notice-contracts.ts"

export class RemoteAgentStoreConflictNoticeStub implements Executor<Record<string, unknown>, Record<string, unknown>> {
  async execute(_context: unknown, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (request.op) {
      case "ack": return { kind: "acked", count: 0 }
      case "release": return { kind: "released", count: 0 }
      case "noteDeferredEagerWrittenPaths": return { kind: "noted", count: 0 }
      default: return { kind: "not-applicable" }
    }
  }
}

import { errorLogTag } from "../../../shared/errors/summary.ts"
import { SLATE_NOTIFY_TOPICS, type SlateNotifyTopic } from "./notify-bus-client.ts"

export interface NotifyBusHandlers {
  subscribe(topic: SlateNotifyTopic, handler: () => void): () => void
  dispatch(topic: SlateNotifyTopic): void
  clear(): void
}

export function createNotifyBusHandlers(log: (message: string) => void): NotifyBusHandlers {
  const byTopic = Object.fromEntries(
    SLATE_NOTIFY_TOPICS.map(topic => [topic, new Set<() => void>()]),
  ) as Record<SlateNotifyTopic, Set<() => void>>

  return {
    subscribe(topic, handler) {
      byTopic[topic].add(handler)
      return () => byTopic[topic].delete(handler)
    },
    dispatch(topic) {
      for (const handler of byTopic[topic]) {
        try {
          handler()
        } catch (error) {
          log("[slate:notify-bus] " + topic + " drain handler failed: " + errorLogTag(error))
        }
      }
    },
    clear() {
      for (const handlers of Object.values(byTopic)) handlers.clear()
    },
  }
}

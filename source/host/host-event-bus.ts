/**
 * The bus the host's extensions talk over.
 *
 * A topic carries events to whoever subscribed to it, a subscriber that throws does not stop the others, and what is
 * published is bounded so one noisy extension cannot drown the rest.
 */
import { createHostEvents } from "./extensions/host-extensions.ts";
import { errorLogTag } from "../shared/errors/summary.ts";

type HostEventFailureKind = "listener_failed" | "subscriber_failed"
type TopicEmitOptions = { readonly failureMode?: "reject" }

export class SlateHostEventBus<Event = unknown> {
  private readonly broadcastListeners = new Set<(event: Event) => void>()
  private readonly topicEvents: ReturnType<typeof createHostEvents>

  constructor(private readonly reportFailure: (failure: Readonly<Record<string, unknown>>) => void = () => {}) {
    this.topicEvents = createHostEvents({
      onHandlerFailure: (topic, error) => {
        this.reportDispatchFailure("subscriber_failed", error, topic)
      },
    })
  }

  emit(event: Event): void;
  emit(topic: string, payload: unknown, options?: TopicEmitOptions): Promise<void>;
  emit(signalOrTopic: Event | string, body?: unknown, delivery?: TopicEmitOptions): void | Promise<void> {
    if (arguments.length > 1) return this.topicEvents.emit(signalOrTopic as string, body, delivery)
    this.publishToBroadcastListeners(signalOrTopic as Event)
  }

  on(topic: string, handler: (payload: unknown) => unknown): () => void {
    return this.topicEvents.on(topic, handler)
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.broadcastListeners.add(listener)
    return () => {
      this.broadcastListeners.delete(listener)
    }
  }

  private publishToBroadcastListeners(signal: Event): void {
    for (const observer of this.broadcastListeners) {
      try {
        observer(signal)
      } catch (error) {
        this.reportDispatchFailure("listener_failed", error)
      }
    }
  }

  private reportDispatchFailure(kind: HostEventFailureKind, error: unknown, topic?: string): void {
    const failure: Record<string, unknown> = { kind, errorClass: errorLogTag(error) }
    if (topic !== undefined) failure.topic = topic
    this.reportFailure(failure)
  }
}

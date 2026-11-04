import type { Context } from "../../../packages/context/context.ts";
import { captureComputerUseScreenshot, type ScreenshotBox } from "../../../adapters/interop/agent/computer-use-executor-adapter.ts";
import type { BoxHandoffDeps } from "./box-handoff-service.ts";

export interface SessionProductionHandoffBindings {
  readonly box: ScreenshotBox;
  readonly context: Context;
  readonly events: {
    emit(topic: string, payload: unknown, options?: { failureMode?: "reject" }): Promise<void>;
  };
  readonly telemetry: {
    reportBoxHelp(event: Record<string, unknown>): void;
    trackEvent(name: string, properties: Record<string, unknown>): void;
  };
}

const HANDOFF_TOPICS = {
  began: "session.box-handoff-started",
  ended: "session.box-handoff-ended",
  changed: "session.box-handoff-status-changed",
} as const;

/** Binds box actions and host notifications to the session handoff policy. */
export function createSessionProductionHandoffDependencies(
  bindings: SessionProductionHandoffBindings,
): BoxHandoffDeps {
  const { box, context, events, telemetry } = bindings;
  const notifyWithoutWaiting = (topic: string, payload: unknown): void => {
    void events.emit(topic, payload);
  };
  return {
    grabScreenshot: agentId => captureComputerUseScreenshot(box, context, agentId),
    onStarted: event => notifyWithoutWaiting(HANDOFF_TOPICS.began, event),
    onEnded: event => events.emit(HANDOFF_TOPICS.ended, event, { failureMode: "reject" }),
    onStatusChanged: agentId => notifyWithoutWaiting(HANDOFF_TOPICS.changed, { agentId }),
    telemetry: {
      reportBoxHelp: event => telemetry.reportBoxHelp(event),
      trackEvent: (name, properties) => telemetry.trackEvent(name, properties),
    },
  };
}

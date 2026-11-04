import { SLATE_NOTIFY_TOPICS } from "./notify-bus-contracts.ts";
import type { SlateNotifyFrame, SlateNotifyTopic } from "./notify-bus-contracts.ts";

export function isSlateNotifyTopic(value: unknown): value is SlateNotifyTopic {
  return typeof value === "string" && SLATE_NOTIFY_TOPICS.includes(value as SlateNotifyTopic);
}

/** Read the final data field from one SSE block and ignore payloads this bus does not define. */
export function parseNotifyFrame(frame: string): SlateNotifyFrame {
  const data = lastDataLine(frame);
  if (data == null) return ignoredFrame();

  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch {
    return ignoredFrame();
  }
  if (!isNotifyObject(payload)) return ignoredFrame();

  if (payload.kind === "connected") return connectedFrame();
  if (payload.kind === "notify" && isSlateNotifyTopic(payload.topic)) {
    return notifyFrame(payload.topic);
  }
  return ignoredFrame();
}

function ignoredFrame(): SlateNotifyFrame {
  return { kind: "ignored" };
}

function connectedFrame(): SlateNotifyFrame {
  return { kind: "connected" };
}

function notifyFrame(topic: SlateNotifyTopic): SlateNotifyFrame {
  return { kind: "notify", topic };
}

function lastDataLine(frame: string): string | null {
  let data: string | null = null;
  for (const line of frame.split("\n")) {
    if (line.startsWith("data: ")) data = line.slice("data: ".length);
  }
  return data;
}

function isNotifyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

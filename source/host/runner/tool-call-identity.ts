/**
 * The name a tool call was made under.
 *
 * A model's tool call may be recorded before the platform knows which tool it is, so the name is remembered by the
 * call's id and handed over when the update arrives; both the names and the pending updates are bounded, since a session
 * may see more calls than it ever resolves.
 */

/** An update about a tool call, as the surface carries it. */
export interface ToolSurfaceUpdate { readonly name?: string; readonly [key: string]: unknown }

/** Where an update about a tool call goes. */
interface ToolCallUpdateSink {
  emitUpdate(update: ToolSurfaceUpdate): void;
}

/** The most names and pending updates remembered at once, per session. */
const TOOL_CALL_MEMORY_LIMIT = 128;

/** The event that says a tool call is over. */
const TOOL_CALL_COMPLETED_EVENT = "toolCallCompleted";
const SLATE_TOOL_CALL_COMPLETED_PHASE = "completed";

/** What one session's tool calls are known by, while they are being run. */
export function createToolCallIdentity(host: ToolCallUpdateSink) {
  /** The name each call was made under, by the call's id. */
  const names = new Map<string, string>();
  /** The updates of calls whose tool is not known yet, by the call's id. */
  const pending = new Map<string, ToolSurfaceUpdate>();

  /** Keep a map inside the limit by dropping the entry it remembered first. */
  const cap = <T>(map: Map<string, T>): void => {
    if (map.size < TOOL_CALL_MEMORY_LIMIT) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  };

  /** Remember the name a call was made under, and hand over an update that was waiting for it. */
  const recordModelToolName = (id: string, name: string): void => {
    cap(names);
    names.set(id, name);
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    host.emitUpdate({ ...waiting, name });
  };

  /** The name a call was made under, or the outline's name when the call has none. */
  const resolveModelToolName = (event: string, id: string, outline: string): string => {
    const name = names.get(id);
    if (event === TOOL_CALL_COMPLETED_EVENT || event === SLATE_TOOL_CALL_COMPLETED_PHASE) {
      names.delete(id);
      pending.delete(id);
    }
    return name ?? outline;
  };

  /** Keep an update for a call whose tool is not known yet. */
  const stashSurfaceUnresolvedPending = (id: string, update: ToolSurfaceUpdate): void => {
    cap(pending);
    pending.set(id, update);
  };

  return { recordModelToolName, resolveModelToolName, stashSurfaceUnresolvedPending };
}

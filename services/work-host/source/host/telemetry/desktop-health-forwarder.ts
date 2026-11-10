/**
 * What the shared desktop reports about itself.
 *
 * The desktop runs the components a box needs in order to be a computer — an X server, a window manager, VNC, an egress
 * proxy — and it reports their health as a snapshot. This file turns that snapshot into one telemetry event, and it is
 * deliberately narrow about what it will accept:
 *
 * - **only the platform's own components exist here** — a report naming anything else is dropped, not forwarded, because
 *   the name in a health report is the platform's own surface;
 * - **a reason is one of the known ones, or a category** — a signal or an exit code is reported as `signal`/`exit`, and
 *   everything unrecognized becomes `unknown`, so a dashboard never has to parse free text;
 * - **the summary is the components' own truth** — up, down, crashlooping and restarts are counted from the accepted
 *   components after duplicates have been merged, never taken from the snapshot's own totals;
 * - **forwarding is what changed or what has gone quiet** — a new revision goes out immediately, the same revision only on
 *   the heartbeat.
 */
export const DESKTOP_COMPONENT_NAME_PATTERN = /^(d[1-9][0-9]*|shared)\/(xvfb|xfwm4|picom|x11vnc|websockify|dock|fork-websockify|fork-router|egress-proxy)$/;
export const MAX_DOWN_DETAIL_LENGTH = 256;
export const MAX_COMPONENT_RESTARTS = 10_000;

/** The component kinds the desktop may report, and the scope a group prefix means in the event. */
const COMPONENT_KINDS = new Set(["xvfb", "xfwm4", "picom", "x11vnc", "websockify", "dock", "fork-websockify", "fork-router", "egress-proxy"]);

const SCOPE_BY_GROUP: Readonly<Record<string, string>> = { d1: "primary", shared: "shared" };

/** The reasons a component can be down, as the platform's own vocabulary. */
const DOWN_REASONS = new Set([
  "port-in-use", "x-server-active", "already-running", "no-display", "oom", "glx", "x-io-error", "fatal-server",
  "awaiting-dependency", "compositor-disabled", "port-not-listening", "listener-procfs-unavailable", "unknown",
]);

export interface ComponentHealth {
  name: string;
  up: boolean;
  crashloop: boolean;
  restartsInWindow: number;
  downReason?: string;
}

export interface DesktopHealth {
  updatedAtMs: number;
  revision: number;
  supervisionEnabled: boolean;
  total: number;
  up: number;
  down: number;
  crashlooping: number;
  restartsInWindow: number;
  components: ComponentHealth[];
}

/** `d3/xvfb` becomes `fork/xvfb`, `d1/xvfb` becomes `primary/xvfb`, `shared/xvfb` stays shared — and nothing else is a name. */
export function normalizeDesktopComponentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = DESKTOP_COMPONENT_NAME_PATTERN.exec(value);
  const group = match?.[1];
  const kind = match?.[2];
  if (group === undefined || kind === undefined || !COMPONENT_KINDS.has(kind)) return undefined;
  return `${SCOPE_BY_GROUP[group] ?? "fork"}/${kind}`;
}

/** A reason the platform recognizes, or the category it belongs to: a signal, an exit status, or nothing it knows. */
export function normalizeDesktopDownReason(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (DOWN_REASONS.has(value)) return value;
  if (/^signal-SIG[A-Z0-9]+$/.test(value)) return "signal";
  if (/^exit--?[0-9]+$/.test(value)) return "exit";
  return "unknown";
}

/** A count that is a count: a non-integer, a negative or something that is not a number is zero, and the ceiling holds. */
export function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_COMPONENT_RESTARTS);
}

/**
 * Two reports of one component become one: down if either says so, crashlooping if either does, the restarts summed (up to
 * the ceiling), and the reason — the one the newer report gives, or `multiple` when the two disagree.
 */
export function mergeDesktopComponentHealth(current: ComponentHealth, next: ComponentHealth): ComponentHealth {
  const up = current.up && next.up;
  const first = current.downReason;
  const second = next.downReason;
  let downReason = second ?? first ?? "unknown";
  if (first !== undefined && second !== undefined && first !== second) downReason = "multiple";
  return {
    name: current.name,
    up,
    crashloop: current.crashloop || next.crashloop,
    restartsInWindow: Math.min(MAX_COMPONENT_RESTARTS, current.restartsInWindow + next.restartsInWindow),
    ...(up ? {} : { downReason }),
  };
}

/** The header a snapshot must carry: a revision and a timestamp, both non-negative integers. */
function readSnapshotHeader(value: Record<string, unknown>): { readonly revision: number; readonly updatedAtMs: number } | null {
  const usable = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  if (!usable(value.revision) || !usable(value.updatedAtMs)) return null;
  return { revision: value.revision, updatedAtMs: value.updatedAtMs };
}

/** One reported component, or nothing when its name is not one of the platform's own. */
function readComponent(entry: unknown): ComponentHealth | null {
  if (typeof entry !== "object" || entry === null) return null;
  const reported = entry as Record<string, unknown>;
  const name = normalizeDesktopComponentName(reported.name);
  if (name === undefined) return null;
  const downReason = normalizeDesktopDownReason(reported.downReason);
  return {
    name,
    up: reported.up === true,
    crashloop: reported.crashloop === true,
    restartsInWindow: normalizeCount(reported.restartsInWindow),
    ...(downReason === undefined ? {} : { downReason }),
  };
}

/**
 * A snapshot as the event needs it, or nothing when it is not one. The components are the ones this platform runs, a
 * component reported twice is merged once, and every summary count comes from those components.
 */
export function parseDesktopHealthSnapshot(raw: string): DesktopHealth | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const reported = value as Record<string, unknown>;
  const header = readSnapshotHeader(reported);
  if (header === null || !Array.isArray(reported.components)) return null;
  const byName = new Map<string, ComponentHealth>();
  for (const entry of reported.components) {
    const component = readComponent(entry);
    if (component === null) continue;
    const current = byName.get(component.name);
    byName.set(component.name, current === undefined ? component : mergeDesktopComponentHealth(current, component));
  }
  const components = [...byName.values()];
  const up = components.filter((component) => component.up).length;
  return {
    updatedAtMs: header.updatedAtMs,
    revision: header.revision,
    supervisionEnabled: reported.supervisionEnabled === true,
    total: components.length,
    up,
    down: Math.max(0, components.length - up),
    crashlooping: components.filter((component) => component.crashloop).length,
    restartsInWindow: components.reduce((sum, component) => sum + component.restartsInWindow, 0),
    components,
  };
}

/** The one word a dashboard shows: a crashloop beats degraded, and degraded beats healthy. */
export function desktopHealthOverall(snapshot: DesktopHealth): "crashloop" | "degraded" | "healthy" {
  if (snapshot.crashlooping > 0) return "crashloop";
  if (snapshot.down > 0) return "degraded";
  return "healthy";
}

export function desktopHealthLevel(overall: ReturnType<typeof desktopHealthOverall>): "info" | "warn" {
  return overall === "healthy" ? "info" : "warn";
}

/** The two lists a reader needs when something is wrong: which components, and why each of them says so. */
function describeProblems(problems: readonly ComponentHealth[]): { readonly downDetail: string | undefined; readonly downReason: string | undefined } {
  const clamp = (text: string): string => text.slice(0, MAX_DOWN_DETAIL_LENGTH);
  const withReason = problems.filter((component) => typeof component.downReason === "string" && component.downReason.length > 0);
  return {
    downDetail: problems.length > 0 ? clamp(problems.map((component) => (component.crashloop ? `${component.name}(crashloop)` : component.name)).join(",")) : undefined,
    downReason: withReason.length > 0 ? clamp(withReason.map((component) => `${component.name}=${component.downReason}`).join(",")) : undefined,
  };
}

export function computeDesktopHealthMetadata(snapshot: DesktopHealth) {
  const { downDetail, downReason } = describeProblems(snapshot.components.filter((component) => !component.up || component.crashloop));
  return {
    supervision_enabled: String(snapshot.supervisionEnabled),
    overall: desktopHealthOverall(snapshot),
    total: String(snapshot.total),
    up: String(snapshot.up),
    down: String(snapshot.down),
    crashlooping: String(snapshot.crashlooping),
    restarts_window: String(snapshot.restartsInWindow),
    down_detail: downDetail,
    down_reason: downReason,
  };
}

/** A revision that is new goes out at once; the same revision only once its heartbeat is due. */
export function decideDesktopHealthForward(args: {
  lastForwardedRevision: number | null;
  lastForwardedAtMs: number | null;
  revision: number;
  nowMs: number;
  heartbeatMs: number;
}): boolean {
  if (args.lastForwardedRevision === null || args.lastForwardedAtMs === null) return true;
  if (args.revision !== args.lastForwardedRevision) return true;
  return args.nowMs - args.lastForwardedAtMs >= args.heartbeatMs;
}

/**
 * Forwards the desktop's health once: read, parse, decide, emit, remember. The four answers are what the host's poller
 * acts on — absent and unparseable are the two ways there was nothing to forward, skipped means nothing had changed.
 */
export async function forwardDesktopHealth(args: {
  readRaw(): Promise<string | null>;
  getLast(): { revision: number | null; atMs: number | null };
  now(): number;
  heartbeatMs: number;
  emit(level: "info" | "warn", metadata: ReturnType<typeof computeDesktopHealthMetadata>): void;
  setLast(revision: number, atMs: number): void;
}): Promise<"absent" | "parse_error" | "skipped" | "emitted"> {
  const raw = await args.readRaw();
  if (raw == null) return "absent";
  const snapshot = parseDesktopHealthSnapshot(raw);
  if (snapshot == null) return "parse_error";
  const last = args.getLast();
  const nowMs = args.now();
  if (
    !decideDesktopHealthForward({
      lastForwardedRevision: last.revision,
      lastForwardedAtMs: last.atMs,
      revision: snapshot.revision,
      nowMs,
      heartbeatMs: args.heartbeatMs,
    })
  ) {
    return "skipped";
  }
  args.emit(desktopHealthLevel(desktopHealthOverall(snapshot)), computeDesktopHealthMetadata(snapshot));
  args.setLast(snapshot.revision, nowMs);
  return "emitted";
}

/**
 * The trace context a send carries.
 *
 * A send may be traced, and the context travels in the standard header: a trace id, a span id and the flags that say
 * whether it was sampled. What arrives is checked before it is used — the ids are hex of the right length and are not
 * all zeroes, which is what the standard calls invalid — and the sampling ratio is the platform's own choice.
 */
/** A trace id is sixteen bytes written as hex; a span id is eight; the flags are one byte. */
const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;
const HEX_FLAGS = /^[0-9a-f]{2}$/;

/** What the standard calls an invalid id: the right length, and every bit zero. */
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/** The only version this build writes, and the only one it reads. */
const VERSION = "00";

/** Every send is traced by default; a caller may ask for a fraction of them. */
export const SEND_TRACE_SAMPLE_RATIO = 1;

export interface ParsedTraceparent {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/** The four fields of a header, or nothing when it is not four fields at all. */
function fieldsOf(traceparent: string): readonly [string, string, string, string] | undefined {
  const parts = traceparent.trim().split("-");
  if (parts.length !== 4) return undefined;
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? "", parts[3] ?? ""];
}

/** Whether an id is written the way the standard wants it: hex of the right length, and not all zeroes. */
function isUsableId(id: string, pattern: RegExp, zeroes: string): boolean {
  return pattern.test(id) && id !== zeroes;
}

/** A header read back, or nothing when it is not one this build can use. */
export function parseTraceparent(traceparent: unknown): ParsedTraceparent | undefined {
  if (typeof traceparent !== "string") return undefined;
  const fields = fieldsOf(traceparent);
  if (fields === undefined) return undefined;
  const [version, traceId, spanId, flags] = fields;
  if (version !== VERSION) return undefined;
  if (!isUsableId(traceId, HEX_TRACE_ID, ZERO_TRACE_ID)) return undefined;
  if (!isUsableId(spanId, HEX_SPAN_ID, ZERO_SPAN_ID)) return undefined;
  if (!HEX_FLAGS.test(flags)) return undefined;
  const traceFlags = Number.parseInt(flags, 16);
  if (Number.isNaN(traceFlags)) return undefined;
  return { traceId, spanId, traceFlags };
}

/** Random bytes as lower-case hex: the only form the standard allows an id to be written in. */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What could not be built is nothing rather than a failure: a send without a trace is still a send. */
function orNothing<T>(build: () => T): T | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

/** The header for one span: the version, the two ids, and the byte that says whether it was sampled. */
function header(traceId: string, spanId: string, sampled: boolean): string {
  return `${VERSION}-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

/** Whether a send should be traced, given a ratio: nothing at or below zero, everything at or above one. */
export function shouldSampleSend(ratio = SEND_TRACE_SAMPLE_RATIO, random: () => number = Math.random): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  return random() < ratio;
}

/** A new trace, started here: a fresh trace id and span id, and nothing to inherit. */
export function mintTraceparent(sampled = true): { readonly traceparent: string; readonly traceId: string; readonly spanId: string } | undefined {
  return orNothing(() => {
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    return { traceparent: header(traceId, spanId, sampled), traceId, spanId };
  });
}

/** A span inside a trace that is already running: the same trace id, a new span id, and the same sampling decision. */
export function deriveChildTraceparent(parent: string): { readonly traceparent: string; readonly spanId: string } | undefined {
  const parsed = parseTraceparent(parent);
  if (parsed === undefined) return undefined;
  return orNothing(() => {
    const spanId = randomHex(8);
    return { traceparent: header(parsed.traceId, spanId, (parsed.traceFlags & 1) === 1), spanId };
  });
}

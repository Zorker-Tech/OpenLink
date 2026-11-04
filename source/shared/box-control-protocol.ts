/** Slate-owned control protocol shared by the box host client and daemon. */
import { z } from "zod";

export const SLATE_BOX_CONTROL_PROTOCOL_VERSION = 1 as const;
export const SLATE_BOX_CONTROL_PROTOCOL_HEADER = "x-slate-box-protocol-version";
export const SLATE_BOX_CONTROL_PATHS = Object.freeze({
  ping: "/slate-box/v1/control/ping",
  environment: "/slate-box/v1/control/environment",
  mcp: "/slate-box/v1/control/mcp",
});

const environmentSchema = z.record(z.string()).refine(
  (value) => Object.entries(value).every(([name, entry]) => name.length > 0
    && !name.includes("\0")
    && !name.includes("=")
    && !entry.includes("\0")),
  "environment names and values must be valid",
);

export const boxPingResultSchema = z.object({ ok: z.literal(true) }).strict();

export const boxEnvironmentUpdateSchema = z.object({
  env: environmentSchema,
  replace: z.boolean(),
}).strict();

export const boxEnvironmentUpdateResultSchema = z.object({
  applied: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
}).strict();

export const boxMcpLoadRequestSchema = z.object({
  configurationJson: z.string(),
}).strict();

export const boxMcpLoadResultSchema = z.object({
  loadedServerNames: z.array(z.string()),
}).strict();

export const boxControlErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }).strict(),
}).strict();

export type BoxPingResult = z.infer<typeof boxPingResultSchema>;
export type BoxEnvironmentUpdate = z.infer<typeof boxEnvironmentUpdateSchema>;
export type BoxEnvironmentUpdateResult = z.infer<typeof boxEnvironmentUpdateResultSchema>;
export type BoxMcpLoadRequest = z.infer<typeof boxMcpLoadRequestSchema>;
export type BoxMcpLoadResult = z.infer<typeof boxMcpLoadResultSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new TypeError(`${label} is invalid: ${parsed.error.issues.map((issue) =>
    `${issue.path.length === 0 ? "payload" : issue.path.join(".")}: ${issue.message}`
  ).join("; ")}`);
}

export function parseBoxPingResult(value: unknown): BoxPingResult {
  return parse(boxPingResultSchema, value, "box ping result");
}

export function parseBoxEnvironmentUpdate(value: unknown): BoxEnvironmentUpdate {
  return parse(boxEnvironmentUpdateSchema, value, "box environment update");
}

export function parseBoxEnvironmentUpdateResult(value: unknown): BoxEnvironmentUpdateResult {
  return parse(boxEnvironmentUpdateResultSchema, value, "box environment update result");
}

export function parseBoxMcpLoadRequest(value: unknown): BoxMcpLoadRequest {
  return parse(boxMcpLoadRequestSchema, value, "box MCP load request");
}

export function parseBoxMcpLoadResult(value: unknown): BoxMcpLoadResult {
  return parse(boxMcpLoadResultSchema, value, "box MCP load result");
}

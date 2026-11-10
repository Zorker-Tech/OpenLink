/** Slate-owned execution wire used between the box host and box daemon. */
import { z } from "zod";

export const SLATE_BOX_EXEC_PROTOCOL_VERSION = 1 as const;
export const SLATE_BOX_EXEC_PROTOCOL_HEADER = "x-slate-box-exec-version";
export const SLATE_BOX_EXEC_PATH = "/slate-box/v1/exec";
export const SLATE_BOX_EXEC_SCHEMA = "slate.box-exec.operation.v1" as const;

const idSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stringSchema = z.string();
const pathSchema = z.string().min(1);
const schema = z.literal(SLATE_BOX_EXEC_SCHEMA);

export const boxExecRequestSchema = z.discriminatedUnion("op", [
  z.object({
    schema,
    id: idSchema,
    op: z.literal("workspace.read"),
    redacted: z.boolean(),
    path: pathSchema,
    encodingHint: z.string().min(1).optional(),
    offset: idSchema.optional(),
    limit: idSchema.optional(),
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    op: z.literal("shell.run"),
    variant: z.enum(["default", "mini-swe"]),
    command: stringSchema,
    workingDirectory: stringSchema,
    timeout: idSchema,
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    op: z.literal("shell.stream"),
    command: stringSchema,
    workingDirectory: stringSchema,
    timeout: idSchema,
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    op: z.literal("shell.background.spawn"),
    command: stringSchema,
    workingDirectory: stringSchema,
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    op: z.literal("shell.stdin.write"),
    shellId: idSchema,
    chars: stringSchema,
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    op: z.literal("unsupported"),
    sourceOperation: z.string(),
  }).strict(),
]);

export type BoxExecRequest = z.infer<typeof boxExecRequestSchema>;

const readResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    path: z.string(),
    content: z.string(),
    totalLines: idSchema,
    fileSize: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    truncated: z.boolean(),
    rangeApplied: z.boolean(),
  }),
  z.object({ kind: z.literal("invalid-file"), path: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("rejected"), path: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("file-not-found"), path: z.string() }),
  z.object({ kind: z.literal("permission-denied"), path: z.string() }),
  z.object({ kind: z.literal("error"), path: z.string(), error: z.string() }),
]);

const shellRunResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spawn-error"), command: z.string(), workingDirectory: z.string(), error: z.string() }),
  z.object({ kind: z.literal("timeout"), command: z.string(), workingDirectory: z.string(), timeoutMs: idSchema }),
  z.object({
    kind: z.literal("success"),
    command: z.string(),
    workingDirectory: z.string(),
    exitCode: idSchema,
    signal: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    executionTime: idSchema,
    localExecutionTimeMs: idSchema,
    interleavedOutput: z.string(),
  }),
  z.object({
    kind: z.literal("failure"),
    command: z.string(),
    workingDirectory: z.string(),
    exitCode: idSchema,
    signal: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    executionTime: idSchema,
    localExecutionTimeMs: idSchema,
    interleavedOutput: z.string(),
    aborted: z.boolean(),
  }),
]);

const shellStreamEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("stdout"), data: z.string() }),
  z.object({ kind: z.literal("stderr"), data: z.string() }),
  z.object({
    kind: z.literal("exit"),
    code: idSchema,
    cwd: z.string(),
    aborted: z.boolean(),
    localExecutionTimeMs: idSchema,
  }),
]);

export const boxExecResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    schema,
    id: idSchema,
    kind: z.literal("workspace.read"),
    redacted: z.boolean(),
    result: readResult,
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    kind: z.literal("shell.run"),
    variant: z.enum(["default", "mini-swe"]),
    result: shellRunResult,
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    kind: z.literal("shell.stream"),
    event: shellStreamEvent,
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    kind: z.literal("shell.background.spawn"),
    result: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("success"),
        shellId: idSchema,
        command: z.string(),
        workingDirectory: z.string(),
        pid: idSchema.optional(),
      }),
      z.object({ kind: z.literal("error"), command: z.string(), workingDirectory: z.string(), error: z.string() }),
    ]),
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    kind: z.literal("shell.stdin.write"),
    result: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("success"),
        shellId: idSchema,
        terminalFileLengthBeforeInputWritten: idSchema,
      }),
      z.object({ kind: z.literal("error"), error: z.string() }),
    ]),
  }).strict(),
  z.object({
    schema,
    id: idSchema,
    kind: z.literal("control"),
    control: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("throw"), error: z.string(), errorCode: z.string().optional() }),
      z.object({ kind: z.literal("stream.close") }),
    ]),
  }).strict(),
]);

export type BoxExecResponse = z.infer<typeof boxExecResponseSchema>;

function parse<T>(valueSchema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = valueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new TypeError(`${label} is invalid: ${parsed.error.issues.map((issue) =>
    `${issue.path.length === 0 ? "payload" : issue.path.join(".")}: ${issue.message}`
  ).join("; ")}`);
}

export function parseBoxExecRequest(value: unknown): BoxExecRequest {
  return parse(boxExecRequestSchema, value, "box exec request");
}

export function parseBoxExecResponse(value: unknown): BoxExecResponse {
  return parse(boxExecResponseSchema, value, "box exec response");
}

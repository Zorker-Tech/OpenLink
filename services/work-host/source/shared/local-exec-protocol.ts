/** The wire contract between the Work host and a Slate local-exec provider. */
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "@slate/work-domain";

export const SLATE_LOCAL_EXEC_PROTOCOL_VERSION = 1 as const;
export const SLATE_LOCAL_EXEC_OPERATION_SCHEMA = "slate.local-exec.operation.v1" as const;
export const SLATE_LOCAL_EXEC_LEGACY_SCHEMA = "slate.local-exec.legacy.v1" as const;

const protocolVersionSchema = z.literal(SLATE_LOCAL_EXEC_PROTOCOL_VERSION);
const operationSchema = z.literal(SLATE_LOCAL_EXEC_OPERATION_SCHEMA);
const legacySchema = z.literal(SLATE_LOCAL_EXEC_LEGACY_SCHEMA);
const nonemptyIdentifierSchema = z.string().min(1);
const requestIdSchema = z.string().min(1);
const optionalRequestIdSchema = requestIdSchema.optional();
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bytesBase64Schema = z.string().refine(
  (value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value),
  "expected base64 data",
);
const decimalSizeSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const operationNameSchema = z.enum([
  "workspace.read",
  "workspace.list",
  "shell.stream",
  "shell.background.spawn",
]);
const operationResultNameSchema = z.enum([
  "workspace.read.result",
  "workspace.list.result",
  "shell.stream.result",
  "shell.background.spawn.result",
]);

const localExecOperationMarkerSchema = z.union([
  z.object({ schema: operationSchema, id: nonnegativeSafeIntegerSchema, op: operationNameSchema }),
  z.object({ schema: legacySchema, data: jsonValueSchema }),
]);

const localExecMessageMarkerSchema = z.union([
  z.object({ schema: operationSchema, id: nonnegativeSafeIntegerSchema, op: operationResultNameSchema }),
  z.object({ schema: legacySchema, data: jsonValueSchema }),
]);

export type LocalExecOperationRequestWire = z.infer<typeof localExecOperationMarkerSchema>;
export type LocalExecMessageWire = z.infer<typeof localExecMessageMarkerSchema>;

export function wrapLegacyLocalExecMessage(data: JsonValue): {
  readonly schema: typeof SLATE_LOCAL_EXEC_LEGACY_SCHEMA;
  readonly data: JsonValue;
} {
  return { schema: SLATE_LOCAL_EXEC_LEGACY_SCHEMA, data };
}

export function unwrapLegacyLocalExecMessage(value: unknown): JsonValue | undefined {
  const parsed = z.object({ schema: legacySchema, data: jsonValueSchema }).safeParse(value);
  return parsed.success ? parsed.data.data : undefined;
}

const localExecTraceSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  traceFlags: z.number().int().nonnegative().max(0xffff_ffff).optional(),
  traceState: z.string().optional(),
});

export const localExecReadRequestSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  acceptHookAdditionalContexts: z.boolean().optional(),
  trace: localExecTraceSchema.optional(),
  op: z.literal("workspace.read"),
  redacted: z.boolean(),
  args: z.object({
    path: nonemptyIdentifierSchema,
    toolCallId: z.string().optional(),
    offset: nonnegativeSafeIntegerSchema.optional(),
    limit: positiveSafeIntegerSchema.optional(),
    encodingHint: z.string().min(1).optional(),
  }),
});

export type LocalExecReadRequest = z.infer<typeof localExecReadRequestSchema>;

const readSuccessSchema = z.object({
  kind: z.literal("success"),
  path: nonemptyIdentifierSchema,
  body: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }),
    z.object({ kind: z.literal("bytes"), base64: bytesBase64Schema }),
  ]),
  totalLines: nonnegativeSafeIntegerSchema,
  fileSize: decimalSizeSchema,
  truncated: z.boolean(),
  rangeApplied: z.boolean(),
});

export const localExecReadResultSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  localExecutionTimeMs: nonnegativeSafeIntegerSchema.optional(),
  additionalContexts: z.array(jsonValueSchema).optional(),
  op: z.literal("workspace.read.result"),
  redacted: z.boolean(),
  result: z.discriminatedUnion("kind", [
    readSuccessSchema,
    z.object({ kind: z.literal("invalid-file"), path: nonemptyIdentifierSchema, reason: z.string() }),
    z.object({ kind: z.literal("permission-denied"), path: nonemptyIdentifierSchema }),
    z.object({ kind: z.literal("not-found"), path: nonemptyIdentifierSchema }),
    z.object({ kind: z.literal("error"), path: nonemptyIdentifierSchema, error: z.string() }),
  ]),
});

export type LocalExecReadResult = z.infer<typeof localExecReadResultSchema>;

const sandboxNetworkPolicySchema = z.object({
  version: nonnegativeSafeIntegerSchema.optional(),
  default: z.enum(["allow", "deny"]).optional(),
  deny: z.array(z.string()).readonly().optional(),
  allow: z.array(z.string()).readonly().optional(),
  logging: z.object({
    decisionLogPath: z.string().optional(),
    logFormat: z.string().optional(),
  }).optional(),
});

const sandboxRuleSchema = z.object({
  type: z.enum(["insecure_none", "workspace_readwrite", "workspace_readonly"]),
  networkPolicy: sandboxNetworkPolicySchema.optional(),
  skipStatsigDefaults: z.boolean().optional(),
  additionalReadwritePaths: z.array(z.string()).readonly().optional(),
  additionalReadonlyPaths: z.array(z.string()).readonly().optional(),
  disableTmpWrite: z.boolean().optional(),
  enableSharedBuildCache: z.boolean().optional(),
  debugOutputDir: z.string().optional(),
  captureDenies: z.boolean().optional(),
  networkPolicyStrict: z.boolean().optional(),
  readBoundary: z.enum(["system", "workspace"]).optional(),
  additionalReadPaths: z.array(z.string()).readonly().optional(),
  allowlistEscalated: z.boolean().optional(),
  ignoreMapping: jsonValueSchema.optional(),
});

const shellArgsSchema = z.object({
  command: z.string(),
  workingDirectory: z.string().optional(),
  toolCallId: z.string().optional(),
  conversationId: z.string().optional(),
  requestedSandboxPolicy: sandboxRuleSchema.optional(),
  closeStdin: z.boolean().optional(),
  timeout: z.number().int().nonnegative().optional(),
  timeoutBehavior: z.enum(["background", "foreground"]).optional(),
  hardTimeout: z.number().int().nonnegative().optional(),
  fileOutputThresholdBytes: decimalSizeSchema.optional(),
  adminCommandDenylist: z.array(z.string()).readonly().optional(),
  skipApproval: z.boolean().optional(),
  smartModeApproval: z.object({
    reason: z.string().optional(),
    requestId: z.string().optional(),
  }).optional(),
  classifierResult: jsonValueSchema.optional(),
  description: z.string().optional(),
  outputNotification: jsonValueSchema.optional(),
  hookApprovalRequirement: jsonValueSchema.optional(),
  isBackground: z.boolean().optional(),
  simpleCommands: z.array(z.string()).readonly().optional(),
  hasInputRedirect: z.boolean().optional(),
  hasOutputRedirect: z.boolean().optional(),
  parsingResult: jsonValueSchema.optional(),
});

export const localExecShellRequestSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  acceptHookAdditionalContexts: z.boolean().optional(),
  trace: localExecTraceSchema.optional(),
  op: z.literal("shell.stream"),
  args: shellArgsSchema,
});

export type LocalExecShellRequest = z.infer<typeof localExecShellRequestSchema>;

const shellOutputLocationSchema = z.object({
  filePath: nonemptyIdentifierSchema,
  sizeBytes: decimalSizeSchema,
  lineCount: decimalSizeSchema,
});

const shellStreamEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rejected"),
    command: z.string(),
    workingDirectory: z.string(),
    reason: z.string(),
    isReadonly: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("permission-denied"),
    command: z.string(),
    workingDirectory: z.string(),
    error: z.string(),
    isReadonly: z.boolean(),
  }),
  z.object({ kind: z.literal("start"), policy: sandboxRuleSchema.optional() }),
  z.object({ kind: z.literal("stdout"), data: z.string() }),
  z.object({ kind: z.literal("stderr"), data: z.string() }),
  z.object({
    kind: z.literal("exit"),
    code: nonnegativeSafeIntegerSchema,
    cwd: z.string(),
    outputLocation: shellOutputLocationSchema.optional(),
    aborted: z.boolean(),
    abortReason: z.enum(["user-abort", "timeout"]).optional(),
    localExecutionTimeMs: nonnegativeSafeIntegerSchema.optional(),
  }),
  z.object({
    kind: z.literal("sandbox-unsupported"),
    command: z.string(),
    workingDirectory: z.string(),
    policyType: z.string(),
    reason: z.string(),
    readonly: z.boolean(),
  }),
  z.object({
    kind: z.literal("backgrounded"),
    shellId: nonnegativeSafeIntegerSchema,
    command: z.string(),
    workingDirectory: z.string(),
    pid: nonnegativeSafeIntegerSchema.optional(),
    elapsedMs: nonnegativeSafeIntegerSchema,
    reason: z.enum(["user", "timeout", "unspecified"]),
  }),
  z.object({ kind: z.literal("hook-context"), contexts: z.array(jsonValueSchema) }),
]);

export const localExecShellResultSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  localExecutionTimeMs: nonnegativeSafeIntegerSchema.optional(),
  additionalContexts: z.array(jsonValueSchema).optional(),
  op: z.literal("shell.stream.result"),
  event: shellStreamEventSchema,
});

export type LocalExecShellResult = z.infer<typeof localExecShellResultSchema>;

export const localExecListRequestSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  acceptHookAdditionalContexts: z.boolean().optional(),
  trace: localExecTraceSchema.optional(),
  op: z.literal("workspace.list"),
  args: z.object({
    path: nonemptyIdentifierSchema,
    ignore: z.array(z.string()).readonly().optional(),
    toolCallId: z.string().optional(),
    sandboxPolicy: sandboxRuleSchema.optional(),
    timeoutMs: nonnegativeSafeIntegerSchema.optional(),
  }),
});

export type LocalExecListRequest = z.infer<typeof localExecListRequestSchema>;

const directoryFileSchema: z.ZodType<LocalExecDirectoryFile> = z.lazy(() => z.object({
  name: z.string(),
  terminalMetadata: jsonValueSchema.optional(),
}));

export interface LocalExecDirectoryFile {
  readonly name: string
  readonly terminalMetadata?: JsonValue | undefined
}

export interface LocalExecDirectoryNode {
  readonly path: string
  readonly directories: readonly LocalExecDirectoryNode[]
  readonly files: readonly LocalExecDirectoryFile[]
  readonly processed: boolean
  readonly extensionCounts: Readonly<Record<string, number>>
  readonly numFiles: number
}

const directoryNodeSchema: z.ZodType<LocalExecDirectoryNode> = z.lazy(() => z.object({
  path: nonemptyIdentifierSchema,
  directories: z.array(directoryNodeSchema).readonly(),
  files: z.array(directoryFileSchema).readonly(),
  processed: z.boolean(),
  extensionCounts: z.record(nonnegativeSafeIntegerSchema),
  numFiles: nonnegativeSafeIntegerSchema,
}));

export const localExecListResultSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  localExecutionTimeMs: nonnegativeSafeIntegerSchema.optional(),
  additionalContexts: z.array(jsonValueSchema).optional(),
  op: z.literal("workspace.list.result"),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("success"), root: directoryNodeSchema.optional() }),
    z.object({ kind: z.literal("error"), path: nonemptyIdentifierSchema, error: z.string() }),
    z.object({ kind: z.literal("rejected"), path: nonemptyIdentifierSchema, reason: z.string() }),
    z.object({ kind: z.literal("timeout"), root: directoryNodeSchema.optional() }),
  ]),
});

export type LocalExecListResult = z.infer<typeof localExecListResultSchema>;

const backgroundShellArgsSchema = z.object({
  command: z.string(),
  workingDirectory: z.string().optional(),
  toolCallId: z.string().optional(),
  conversationId: z.string().optional(),
  sandboxPolicy: sandboxRuleSchema.optional(),
  adminCommandDenylist: z.array(z.string()).optional(),
  enableWriteShellStdinTool: z.boolean().optional(),
  description: z.string().optional(),
  classifierResult: jsonValueSchema.optional(),
  outputNotification: jsonValueSchema.optional(),
  smartModeApproval: z.object({
    reason: z.string().optional(),
    requestId: z.string().optional(),
  }).optional(),
  hookApprovalRequirement: jsonValueSchema.optional(),
  skipApproval: z.boolean().optional(),
  parsingResult: jsonValueSchema.optional(),
});

export const localExecBackgroundSpawnRequestSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  acceptHookAdditionalContexts: z.boolean().optional(),
  trace: localExecTraceSchema.optional(),
  op: z.literal("shell.background.spawn"),
  args: backgroundShellArgsSchema,
});

export type LocalExecBackgroundSpawnRequest = z.infer<typeof localExecBackgroundSpawnRequestSchema>;

export const localExecBackgroundSpawnResultSchema = z.object({
  schema: operationSchema,
  id: nonnegativeSafeIntegerSchema,
  execId: z.string().min(1).optional(),
  localExecutionTimeMs: nonnegativeSafeIntegerSchema.optional(),
  additionalContexts: z.array(jsonValueSchema).optional(),
  op: z.literal("shell.background.spawn.result"),
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("success"),
      shellId: nonnegativeSafeIntegerSchema,
      command: z.string(),
      workingDirectory: z.string(),
      pid: nonnegativeSafeIntegerSchema.optional(),
    }),
    z.object({ kind: z.literal("rejected"), command: z.string(), workingDirectory: z.string(), reason: z.string() }),
    z.object({
      kind: z.literal("permission-denied"),
      command: z.string(),
      workingDirectory: z.string(),
      error: z.string(),
      isReadonly: z.boolean(),
    }),
    z.object({
      kind: z.literal("sandbox-unsupported"),
      command: z.string(),
      workingDirectory: z.string(),
      policyType: z.string(),
      reason: z.string(),
      isReadonly: z.boolean(),
    }),
    z.object({ kind: z.literal("error"), command: z.string(), workingDirectory: z.string(), error: z.string() }),
  ]),
});

export type LocalExecBackgroundSpawnResult = z.infer<typeof localExecBackgroundSpawnResultSchema>;

const welcomeRequestSchema = z.object({
  kind: z.literal("welcome"),
  providerId: nonemptyIdentifierSchema,
  /** Missing on a pre-versioned provider and treated as a legacy connection by the bridge. */
  protocolVersion: protocolVersionSchema.optional(),
});

const retireApprovalRequestSchema = z.object({
  kind: z.literal("retire-approval"),
  requestId: optionalRequestIdSchema,
  approvalId: nonemptyIdentifierSchema,
});

const execRequestSchema = z.object({
  kind: z.literal("exec"),
  requestId: requestIdSchema,
  approvalId: nonemptyIdentifierSchema.optional(),
  serverMessage: localExecOperationMarkerSchema,
});

const uploadRequestSchema = z.object({
  kind: z.literal("upload"),
  requestId: requestIdSchema,
  approvalId: nonemptyIdentifierSchema.optional(),
  path: nonemptyIdentifierSchema,
  bytesBase64: bytesBase64Schema,
});

const downloadRequestSchema = z.object({
  kind: z.literal("download"),
  requestId: requestIdSchema,
  approvalId: nonemptyIdentifierSchema.optional(),
  path: nonemptyIdentifierSchema,
});

const cancelRequestSchema = z.object({
  kind: z.literal("cancel"),
  requestId: requestIdSchema,
});

export const localExecRequestFrameSchema = z.discriminatedUnion("kind", [
  welcomeRequestSchema,
  retireApprovalRequestSchema,
  execRequestSchema,
  uploadRequestSchema,
  downloadRequestSchema,
  cancelRequestSchema,
]);

export type LocalExecRequestFrame = z.infer<typeof localExecRequestFrameSchema>;

const legacyExecRequestSchema = z.object({
  kind: z.literal("exec"),
  requestId: requestIdSchema,
  approvalId: nonemptyIdentifierSchema.optional(),
  serverMessage: jsonValueSchema,
});

/** Raw execution frames are accepted only from a provider that did not negotiate the Slate protocol version. */
export const legacyLocalExecRequestFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("welcome"),
    providerId: nonemptyIdentifierSchema,
    protocolVersion: protocolVersionSchema.optional(),
  }),
  z.object({
    kind: z.literal("retire-approval"),
    requestId: optionalRequestIdSchema,
    approvalId: nonemptyIdentifierSchema,
  }),
  legacyExecRequestSchema,
  uploadRequestSchema,
  downloadRequestSchema,
  cancelRequestSchema,
]);

export type LegacyLocalExecRequestFrame = z.infer<typeof legacyLocalExecRequestFrameSchema>;

const helloResponseSchema = z.object({
  kind: z.literal("hello"),
  localRoot: nonemptyIdentifierSchema,
  terminalsFolder: nonemptyIdentifierSchema,
  computerId: nonemptyIdentifierSchema,
  label: nonemptyIdentifierSchema,
  supervised: z.boolean().optional(),
  variant: z.string().min(1).optional(),
  /** Missing on a pre-versioned provider and treated as a legacy connection by the bridge. */
  protocolVersion: protocolVersionSchema.optional(),
});

const pingResponseSchema = z.object({
  kind: z.literal("ping"),
  supervised: z.boolean().optional(),
});

const messageResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("client"),
    requestId: requestIdSchema,
    message: localExecMessageMarkerSchema,
    protocolVersion: protocolVersionSchema.optional(),
  }),
  z.object({
    kind: z.literal("control"),
    requestId: requestIdSchema,
    message: localExecMessageMarkerSchema,
    protocolVersion: protocolVersionSchema.optional(),
  }),
]);

const fileResponseSchema = z.object({
  kind: z.literal("file"),
  requestId: requestIdSchema,
  bytesBase64: bytesBase64Schema.optional(),
  protocolVersion: protocolVersionSchema.optional(),
});

const fileErrorResponseSchema = z.object({
  kind: z.literal("file-error"),
  requestId: requestIdSchema,
  error: z.string(),
  protocolVersion: protocolVersionSchema.optional(),
});

export const localExecResponseFrameSchema = z.union([
  helloResponseSchema,
  pingResponseSchema,
  messageResponseSchema,
  fileResponseSchema,
  fileErrorResponseSchema,
]);

export type LocalExecResponseFrame = z.infer<typeof localExecResponseFrameSchema>;

export const localExecResponseBatchSchema = z.object({
  providerId: requestIdSchema.optional(),
  frames: z.array(localExecResponseFrameSchema),
}).strict();

export type LocalExecResponseBatch = z.infer<typeof localExecResponseBatchSchema>;

function parseWithContext<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new TypeError(`${label} is invalid: ${parsed.error.issues.map((issue) => {
    const at = issue.path.length === 0 ? "frame" : issue.path.join(".");
    return `${at}: ${issue.message}`;
  }).join("; ")}`);
}

export function parseLocalExecRequestFrame(value: unknown): LocalExecRequestFrame {
  return parseWithContext(localExecRequestFrameSchema, value, "local-exec request frame");
}

export function parseLegacyLocalExecRequestFrame(value: unknown): LegacyLocalExecRequestFrame {
  return parseWithContext(legacyLocalExecRequestFrameSchema, value, "legacy local-exec request frame");
}

export function parseLocalExecResponseFrame(value: unknown): LocalExecResponseFrame {
  return parseWithContext(localExecResponseFrameSchema, value, "local-exec response frame");
}

export function parseLocalExecResponseBatch(value: unknown): LocalExecResponseBatch {
  return parseWithContext(localExecResponseBatchSchema, value, "local-exec response batch");
}

export function parseLocalExecReadRequest(value: unknown): LocalExecReadRequest | undefined {
  const parsed = localExecReadRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseLocalExecReadResult(value: unknown): LocalExecReadResult | undefined {
  const parsed = localExecReadResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseLocalExecShellRequest(value: unknown): LocalExecShellRequest | undefined {
  const parsed = localExecShellRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseLocalExecShellResult(value: unknown): LocalExecShellResult | undefined {
  const parsed = localExecShellResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseLocalExecListRequest(value: unknown): LocalExecListRequest | undefined {
  const parsed = localExecListRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseLocalExecListResult(value: unknown): LocalExecListResult | undefined {
  const parsed = localExecListResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseLocalExecBackgroundSpawnRequest(value: unknown): LocalExecBackgroundSpawnRequest | undefined {
  const parsed = localExecBackgroundSpawnRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseLocalExecBackgroundSpawnResult(value: unknown): LocalExecBackgroundSpawnResult | undefined {
  const parsed = localExecBackgroundSpawnResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function isCurrentLocalExecProtocol(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "protocolVersion" in value
    && value.protocolVersion === SLATE_LOCAL_EXEC_PROTOCOL_VERSION;
}

export type LocalExecWireJsonValue = JsonValue;

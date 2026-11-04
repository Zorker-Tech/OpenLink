/**
 * Recording what a user does so it can be taught back.
 *
 * What was recorded is kept as steps a reader can follow, bounded in how much it holds, and a recording that cannot be
 * written is reported rather than silently dropped.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createContext, type Context } from "../../../packages/context/context.ts";
import { shellExecutorResource, type ShellExecutor } from "../../../packages/agent-exec/shell.ts";
import { IDLE_TEACH_RECORDING_STATUS, SLATE_TEACH_MAX_DURATION_MS } from "../../../shared/agents/teach-recording.ts";
import { WORKFLOW_REFERENCE_NODE_TYPE } from "../../../shared/workflows.ts";
import { SLATE_MONITOR_HEIGHT, SLATE_MONITOR_WIDTH } from "../../boxes/box-monitor-layout.ts";
import { buildHostShellArgs } from "../../../adapters/interop/agent/box-shell-command-adapter.ts";
import { SLATE_BOX_FIRST_FORK_WINDOW_INDEX, SlateBoxNoMonitorAvailableError } from "../../ports/box.ts";

export const TEACH_SESSIONS_DIR = "/workspace/teach-sessions";
export const TEACH_QUEUES_DIR = `${TEACH_SESSIONS_DIR}/queues`;
export const LEARN_SKILL_NAME = "learn-from-demonstration";
export const TEACH_PRIVATE_MONITOR_MESSAGE = "Teach recording requires a private desktop monitor.";

export interface Recording { agentId: string; startedAtMs: number; sessionDir: string; displayLabel: string }
export interface PendingRecording { agentId: string; queueFile: string; clientNonce: string }
export interface TeachStatus { state: "idle" | "recording"; agentId?: string | null; startedAtMs?: number | null; maxDurationMs: number }
export interface CapHandle { dispose(): void }
interface ShellAccessor { get(resource: typeof shellExecutorResource): ShellExecutor }
interface TeachBoxConnection { remoteAccessor?: unknown }
export interface TeachRecordingBox {
  ensureReady(serviceContext: Context, agentId: string): Promise<TeachBoxConnection>;
  getAgentWindowIndex?(agentId: string): number | undefined;
}
export interface TeachRecordingDeps {
  box: TeachRecordingBox;
  isEnabled(): boolean;
  capPolicy: { wrap(fn: () => void): (() => void) & CapHandle };
  sendLearningPrompt(agentId: string, prompt: { content: string; richText: string; clientNonce: string }): Promise<void>;
  listAgentIds(): Promise<readonly string[]>;
  queueSignatureKey(): Promise<Uint8Array>;
  ensureLearningWorkflow(): Promise<boolean>;
  trackRecordingStarted(event: Record<string, unknown>): void;
  trackRecordingStopped(event: Record<string, unknown>): void;
  reportStartFailed(event: Record<string, unknown>): void;
  reportCapStopFailed(event: Record<string, unknown>): void;
}

export class SlateTeachRecordingError extends Error {
  constructor(readonly kind: string, message: string) { super(message); this.name = "SlateTeachRecordingError"; }
}

export const isForkWindowIndex = (index: number | null | undefined): boolean => index != null && Number.isInteger(index) && index >= SLATE_BOX_FIRST_FORK_WINDOW_INDEX;
export const queueScope = (agentId: string): string => createHash("sha256").update(agentId).digest("hex");
export const signQueueEntry = (key: Uint8Array, agentId: string, file: string): string => createHmac("sha256", key).update(`${agentId}\n${file}`).digest("hex");
export const queueFileForSessionDir = (dir: string): string => `${dir.split("/").at(-1) ?? ""}.json`;
export const learningPromptNonce = (recording: Recording): string => `teach-recording:${queueScope(recording.agentId)}:${queueFileForSessionDir(recording.sessionDir)}`;
export function learningPromptRichText(agentId: string): string { return JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: WORKFLOW_REFERENCE_NODE_TYPE, attrs: { id: LEARN_SKILL_NAME, label: "Learn from demonstration", teachQueueScope: queueScope(agentId) } }] }] }); }

function classifyStartFailure(error: unknown): string {
  if (error instanceof SlateTeachRecordingError) return error.kind;
  if (error instanceof SlateBoxNoMonitorAvailableError) return "no_monitor";
  return "box";
}

function shellAccessorFor(connection: TeachBoxConnection): ShellAccessor {
  const boxAccessor = connection.remoteAccessor as Partial<ShellAccessor> | null | undefined;
  if (typeof boxAccessor?.get !== "function") throw new SlateTeachRecordingError("shell", "teach-recording: box shell accessor is unavailable");
  return boxAccessor as ShellAccessor;
}

export function createTeachRecordingService(deps: TeachRecordingDeps) {
  const serviceContext = createContext().withName("teachRecording"), subscribers = new Set<(status: TeachStatus) => void>();
  let active: Recording | null = null, brokenRecording: Recording | null = null;
  let startingRecording: Promise<TeachStatus> | null = null, stoppingRecording: Promise<TeachStatus> | null = null, disposingPromise: Promise<void> | null = null;
  let capWake: ((() => void) & CapHandle) | null = null, shuttingDown = false, queuedOnBox = false;
  type FinalizationState = { endedAtMs: number; intent: "save" | "discard"; phase: "preparing" | "winding-down" | "checking-workflow" | "dispatching-prompt" };
  let finalization: FinalizationState | null = null;
  let signingKeyPromise: Promise<Uint8Array> | null = null;
  const signingKey = (): Promise<Uint8Array> => signingKeyPromise ??= deps.queueSignatureKey();
  const currentStatus = (): TeachStatus => active == null ? IDLE_TEACH_RECORDING_STATUS : { state: "recording", agentId: active.agentId, startedAtMs: active.startedAtMs, maxDurationMs: SLATE_TEACH_MAX_DURATION_MS };
  const notifySubscribers = (): void => { const status = currentStatus(); for (const listener of subscribers) listener(status); };
  const boxFailure = (kind: string, action: string, result: { stdout: string; stderr: string }): SlateTeachRecordingError =>
    new SlateTeachRecordingError(kind, `teach-recording: ${action}: ${result.stdout} ${result.stderr}`);
  const runOnBox = async (connection: TeachBoxConnection, command: string, toolCallId: string) => {
    const result = await shellAccessorFor(connection).get(shellExecutorResource).execute(serviceContext, buildHostShellArgs({ command, name: "bash", workingDirectory: "/workspace", toolCallId }));
    if (result.result.case !== "success") throw new SlateTeachRecordingError("shell", `teach-recording shell failed: ${result.result.case}`);
    return result.result.value;
  };
  const sessionFileText = (recording: Recording, end?: { endedAtMs: number; endReason: string }): string => JSON.stringify({ startedAt: new Date(recording.startedAtMs).toISOString(), display: recording.displayLabel, maxDurationMs: SLATE_TEACH_MAX_DURATION_MS, videoPath: sessionFile(recording, "demo.mp4"), ffmpegPid: "__FFMPEG_PID__", ...(end == null ? {} : { endedAt: new Date(end.endedAtMs).toISOString(), endReason: end.endReason }) }, null, 2).replace('"__FFMPEG_PID__"', "$pid");
  const completedSessionText = (recording: Recording, endedAtMs: number, signature: string): string => JSON.stringify({ agentId: recording.agentId, sessionDir: recording.sessionDir, clientNonce: learningPromptNonce(recording), signature, startedAt: new Date(recording.startedAtMs).toISOString(), endedAt: new Date(endedAtMs).toISOString() }, null, 2);
  const sessionFile = (recording: Recording, name: string): string => `${recording.sessionDir}/${name}`;
  const queueFile = (recording: Recording): string => queueFileForSessionDir(recording.sessionDir);
  const ffmpegOwnsVideo = (pidExpr: string, videoPath: string): string => `kill -0 ${pidExpr} 2>/dev/null && tr '\\0' ' ' < /proc/${pidExpr}/cmdline 2>/dev/null | grep -qF ${JSON.stringify(videoPath)}`;
  const discardOnBox = (connection: TeachBoxConnection, recording: Recording, verifyCmdline: string) => runOnBox(connection, [
    `pid=$(tr -d '[:space:]' < ${recording.sessionDir}/ffmpeg.pid 2>/dev/null || true)`,
    `if [ -n "$pid" ] && ${verifyCmdline}; then`, "  kill -INT \"$pid\" || true", "  sleep 1", `  if ${verifyCmdline}; then kill -KILL "$pid" || true; fi`,
    "  for _ in 1 2 3 4 5; do", `    if ! ( ${verifyCmdline} ); then break; fi`, "    sleep 0.2", "  done", `  if ${verifyCmdline}; then`, `    : > ${recording.sessionDir}/startup.invalid`, "    exit 1", "  fi", "fi",
    `queue_dir=${TEACH_QUEUES_DIR}/${queueScope(recording.agentId)}`, `queue_file="$queue_dir/pending/${queueFile(recording)}"`, `rm -f "$queue_file" "$queue_file.prompt-delivered" "$queue_dir/claimed/${queueFile(recording)}"`, `rm -rf ${recording.sessionDir}`
  ].join("\n"), "slate-teach-recording-discard");
  const cleanFailedStart = async (connection: TeachBoxConnection, recording: Recording): Promise<void> => {
    const result = await discardOnBox(connection, recording, ffmpegOwnsVideo('"$pid"', sessionFile(recording, "demo.mp4")));
    if (result.exitCode !== 0) throw boxFailure("cleanup_failed", "failed to clean up recording startup", result);
  };
  const recoverBrokenStart = async (): Promise<void> => { const recording = brokenRecording; if (recording == null) return; await cleanFailedStart(await deps.box.ensureReady(serviceContext, recording.agentId), recording); if (brokenRecording === recording) brokenRecording = null; };
  const releaseCap = (): void => { capWake?.dispose(); capWake = null; };
  const installCap = (recording: Recording): void => {
    if (shuttingDown || capWake != null) return;
    capWake = deps.capPolicy.wrap(() => { capWake = null; if (!shuttingDown) void stop({ agentId: recording.agentId, save: true, trackCompletion: true }).catch(error => deps.reportCapStopFailed({ errorClass: error instanceof Error ? error.name || "Error" : "unknown" })); });
    capWake();
  };
  const markDelivered = async (connection: TeachBoxConnection, pending: PendingRecording): Promise<void> => {
    const result = await runOnBox(connection, [`queue_dir=${TEACH_QUEUES_DIR}/${queueScope(pending.agentId)}`, `queue_file="$queue_dir/pending/${pending.queueFile}"`, `if [ -f "$queue_file" ]; then : > "$queue_file.prompt-delivered"; fi`].join("\n"), "slate-teach-recording-mark-prompt-delivered");
    if (result.exitCode !== 0) throw boxFailure("mark_prompt_failed", "failed to mark learning prompt delivered", result);
  };
  const pendingFromQueue = (agentId: string, key: Uint8Array, queuedFile: string, content: string): PendingRecording | null => {
    try {
      const value = JSON.parse(Buffer.from(content, "base64").toString("utf8")) as Record<string, unknown>;
      const sessionDir = `${TEACH_SESSIONS_DIR}/${queuedFile.slice(0, -5)}`, clientNonce = `teach-recording:${queueScope(agentId)}:${queuedFile}`;
      if (value == null || typeof value !== "object" || value.agentId !== agentId || value.sessionDir !== sessionDir || value.clientNonce !== clientNonce || typeof value.signature !== "string" || !/^[0-9a-f]{64}$/.test(value.signature)) return null;
      const expected = Buffer.from(signQueueEntry(key, agentId, queuedFile), "hex"), given = Buffer.from(value.signature, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected) ? { agentId, queueFile: queuedFile, clientNonce } : null;
    } catch { return null; }
  };
  const queueScanScript = (glob: string): string => [
    `for queue_file in ${glob}; do`, `  [ -f "$queue_file" ] || continue`, `  if [ -e "$queue_file.prompt-delivered" ]; then marker=1; else marker=0; fi`, `  printf '%s\\t%s\\t%s\\t' "$(basename "$(dirname "$(dirname "$queue_file")")")" "$(basename "$queue_file")" "$marker"`, `  base64 "$queue_file" | tr -d '\\n'`, "  printf '\\n'", "done"
  ].join("\n");
  type QueueScan = { scope: string; queueFile: string; delivered: boolean; recording: PendingRecording | null };
  const parseQueueScanLines = (stdout: string, key: Uint8Array, agentsByScope: ReadonlyMap<string, string>): QueueScan[] => stdout.split("\n").map(line => {
    const [scope, queuedFile, marker, content, ...rest] = line.split("\t");
    if (rest.length > 0 || scope == null || queuedFile == null || marker == null || content == null || !/^[0-9a-f]{64}$/.test(scope) || !/^teach-\d{8}T\d{6}Z-[0-9a-f-]{36}\.json$/.test(queuedFile) || marker !== "0" && marker !== "1") return null;
    const agentId = agentsByScope.get(scope); return agentId == null ? null : { scope, queueFile: queuedFile, delivered: marker === "1", recording: pendingFromQueue(agentId, key, queuedFile, content) };
  }).filter((entry): entry is QueueScan => entry != null);
  const quarantineQueueEntries = async (connection: TeachBoxConnection, entries: readonly Pick<QueueScan, "scope" | "queueFile">[]): Promise<void> => {
    if (entries.length === 0) return;
    const result = await runOnBox(connection, entries.flatMap(({ scope, queueFile: file }) => { const dir = `${TEACH_QUEUES_DIR}/${scope}`; return [`mkdir -p ${dir}/rejected`, `mv -f ${dir}/pending/${file} ${dir}/rejected/${file} 2>/dev/null || true`, `rm -f ${dir}/pending/${file}.prompt-delivered`]; }).join("\n"), "slate-teach-recording-quarantine");
    if (result.exitCode !== 0) throw boxFailure("quarantine_failed", "failed to quarantine forged queue entries", result);
  };
  const verifyQueueAuthentic = async (connection: TeachBoxConnection, agentId: string): Promise<void> => {
    const key = await signingKey(), scope = queueScope(agentId), result = await runOnBox(connection, queueScanScript(`${TEACH_QUEUES_DIR}/${scope}/pending/*.json`), "slate-teach-recording-verify");
    if (result.exitCode !== 0) throw boxFailure("finalize_failed", "failed to verify queue authenticity", result);
    await quarantineQueueEntries(connection, parseQueueScanLines(result.stdout, key, new Map([[scope, agentId]])).filter(entry => entry.recording == null));
  };
  const recoverPendingRecordings = async (): Promise<void> => {
    if (!deps.isEnabled()) return;
    const agentIds = await deps.listAgentIds(), firstAgentId = agentIds[0]; if (firstAgentId == null) return;
    const agentsByScope = new Map(agentIds.map(agentId => [queueScope(agentId), agentId])), key = await signingKey(), connection = await deps.box.ensureReady(serviceContext, firstAgentId);
    const result = await runOnBox(connection, queueScanScript(`${TEACH_QUEUES_DIR}/*/pending/*.json`), "slate-teach-recording-recover");
    if (result.exitCode !== 0) throw boxFailure("recover_failed", "failed to recover pending recordings", result);
    const entries = parseQueueScanLines(result.stdout, key, agentsByScope); await quarantineQueueEntries(connection, entries.filter(entry => entry.recording == null));
    const pending = entries.flatMap(entry => entry.recording != null && !entry.delivered ? [entry.recording] : []); if (pending.length === 0 || !await deps.ensureLearningWorkflow()) return;
    for (const recording of pending) { await deps.sendLearningPrompt(recording.agentId, { content: "The recording is finished. Learn the task from it.", richText: learningPromptRichText(recording.agentId), clientNonce: recording.clientNonce }); await markDelivered(connection, recording); }
  };
  const beginRecording = async (request: { agentId: string; entryPoint?: string }): Promise<TeachStatus> => {
    await recoverBrokenStart(); const connection = await deps.box.ensureReady(serviceContext, request.agentId), windowIndex = deps.box.getAgentWindowIndex?.(request.agentId);
    if (!isForkWindowIndex(windowIndex)) throw new SlateBoxNoMonitorAvailableError(TEACH_PRIVATE_MONITOR_MESSAGE);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const recording: Recording = { agentId: request.agentId, startedAtMs: Date.now(), sessionDir: `${TEACH_SESSIONS_DIR}/teach-${stamp}-${randomUUID()}`, displayLabel: `:${windowIndex}` };
    const videoPath = sessionFile(recording, "demo.mp4"), maxSeconds = Math.round(SLATE_TEACH_MAX_DURATION_MS / 1_000), inputArgs = `-video_size ${SLATE_MONITOR_WIDTH}x${SLATE_MONITOR_HEIGHT} -i :${windowIndex}.0`; brokenRecording = recording;
    try {
      const result = await runOnBox(connection, [`mkdir -p ${recording.sessionDir}`, `nohup ffmpeg -y -v error -f x11grab ${inputArgs} -framerate 15 -t ${maxSeconds} -c:v libx264 -preset ultrafast -g 75 -pix_fmt yuv420p -an ${videoPath} > ${recording.sessionDir}/ffmpeg.log 2>&1 &`, `printf '%s\\n' "$!" > ${recording.sessionDir}/ffmpeg.pid`, "sleep 0.4", `pid=$(tr -d '[:space:]' < ${recording.sessionDir}/ffmpeg.pid)`, `case "$pid" in ''|*[!0-9]*) cat ${recording.sessionDir}/ffmpeg.log; exit 1 ;; esac`, `${ffmpegOwnsVideo('"$pid"', videoPath)} || { cat ${recording.sessionDir}/ffmpeg.log; exit 1; }`, `cat > ${recording.sessionDir}/session.json <<SESSION_JSON`, sessionFileText(recording), "SESSION_JSON"].join("\n"), "slate-teach-recording-start");
      if (result.exitCode !== 0) throw boxFailure("start_failed", "ffmpeg failed to start", result);
    } catch (error) {
      try { await cleanFailedStart(connection, recording); if (brokenRecording === recording) brokenRecording = null; } catch (cleanupError) { throw new SlateTeachRecordingError("cleanup_failed", `teach-recording: ffmpeg startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
      throw error;
    }
    if (brokenRecording === recording) brokenRecording = null; active = recording; queuedOnBox = false; installCap(recording); deps.trackRecordingStarted({ agent_id: request.agentId, entry_point: request.entryPoint }); notifySubscribers(); return currentStatus();
  };
  const reportBeginFailure = (request: { agentId: string; entryPoint?: string }, error: unknown): void => deps.reportStartFailed({ kind: classifyStartFailure(error), errorClass: error instanceof Error ? error.name || "Error" : "unknown", windowIndex: deps.box.getAgentWindowIndex?.(request.agentId), entryPoint: request.entryPoint });
  const start = async (request: { agentId: string; entryPoint?: string }): Promise<TeachStatus> => {
    if (shuttingDown) { const error = new SlateTeachRecordingError("shutting_down", "teach-recording: recording service is shutting down"); reportBeginFailure(request, error); throw error; }
    if (!deps.isEnabled()) { const error = new SlateTeachRecordingError("disabled", "teach-recording: the feature gate is off"); reportBeginFailure(request, error); throw error; }
    if (active != null) return currentStatus(); if (startingRecording != null) return startingRecording;
    const startup = beginRecording(request); startingRecording = startup; try { return await startup; } catch (error) { reportBeginFailure(request, error); throw error; } finally { if (startingRecording === startup) startingRecording = null; }
  };
  const stop = async ({ agentId, save, trackCompletion }: { agentId: string; save: boolean; trackCompletion: boolean }): Promise<TeachStatus> => {
    const recording = active; if (recording != null && recording.agentId !== agentId) throw new SlateTeachRecordingError("agent_mismatch", "teach-recording: recording belongs to a different agent");
    if (finalization != null) { if (!save && finalization.phase !== "dispatching-prompt") finalization.intent = "discard"; return await stoppingRecording ?? currentStatus(); }
    if (recording == null) return currentStatus();
    const state: FinalizationState = { endedAtMs: Date.now(), intent: save ? "save" : "discard", phase: "preparing" }; finalization = state;
    const operation = (async (): Promise<TeachStatus> => {
      const connection = await deps.box.ensureReady(serviceContext, recording.agentId), videoPath = sessionFile(recording, "demo.mp4"), readPid = `pid=$(tr -d '[:space:]' < ${recording.sessionDir}/ffmpeg.pid) || exit 1`, validatePid = `case "$pid" in ''|*[!0-9]*) exit 1 ;; esac`, verifyCmdline = ffmpegOwnsVideo('"$pid"', videoPath), shouldDiscard = () => state.intent === "discard";
      state.phase = "winding-down"; const windDownWasSave = state.intent === "save", signature = windDownWasSave ? signQueueEntry(await signingKey(), recording.agentId, queueFile(recording)) : "";
      const windDown = windDownWasSave ? runOnBox(connection, ["set -e", readPid, validatePid, `if ${verifyCmdline}; then kill -INT "$pid"; fi`, `cat > ${recording.sessionDir}/session.json <<SESSION_JSON`, sessionFileText(recording, { endedAtMs: state.endedAtMs, endReason: "stopped" }), "SESSION_JSON", `queue_dir=${TEACH_QUEUES_DIR}/${queueScope(recording.agentId)}`, `queue_file="$queue_dir/pending/${queueFile(recording)}"`, `mkdir -p "$queue_dir/pending" "$queue_dir/claimed"`, `cat > "$queue_file.tmp.$$" <<COMPLETED_SESSION_JSON`, completedSessionText(recording, state.endedAtMs, signature), "COMPLETED_SESSION_JSON", `if [ ! -e "$queue_file" ] && [ ! -e "$queue_dir/claimed/$(basename "$queue_file")" ]; then mv "$queue_file.tmp.$$" "$queue_file"; else rm -f "$queue_file.tmp.$$"; fi`].join("\n"), "slate-teach-recording-stop") : discardOnBox(connection, recording, verifyCmdline);
      const result = await windDown; queuedOnBox = windDownWasSave && result.exitCode === 0;
      if (shouldDiscard() && windDownWasSave) { const discarded = await discardOnBox(connection, recording, verifyCmdline); queuedOnBox = false; if (discarded.exitCode !== 0) throw boxFailure("finalize_failed", "failed to finalize recording", discarded); }
      else if (result.exitCode !== 0) throw boxFailure("finalize_failed", "failed to finalize recording", result);
      if (!shouldDiscard()) {
        state.phase = "checking-workflow"; const workflowAvailable = await deps.ensureLearningWorkflow();
        if (shouldDiscard()) { const discarded = await discardOnBox(connection, recording, verifyCmdline); queuedOnBox = false; if (discarded.exitCode !== 0) throw boxFailure("finalize_failed", "failed to finalize recording", discarded); }
        else if (!workflowAvailable) throw new SlateTeachRecordingError("workflow_unavailable", "teach-recording: learning workflow is unavailable");
        else { state.phase = "dispatching-prompt"; await verifyQueueAuthentic(connection, recording.agentId); const pending = { agentId: recording.agentId, queueFile: queueFile(recording), clientNonce: learningPromptNonce(recording) }; await deps.sendLearningPrompt(recording.agentId, { content: "The recording is finished. Learn the task from it.", richText: learningPromptRichText(recording.agentId), clientNonce: pending.clientNonce }); await markDelivered(connection, pending); }
      }
      active = null; releaseCap(); notifySubscribers(); if (trackCompletion) deps.trackRecordingStopped({ agent_id: recording.agentId, outcome: state.intent === "save" ? "saved" : "discarded", duration_seconds: Math.round((state.endedAtMs - recording.startedAtMs) / 1_000) }); return currentStatus();
    })();
    stoppingRecording = operation; try { return await operation; } finally { if (stoppingRecording === operation) stoppingRecording = null; if (finalization === state) finalization = null; if (active === recording && !shuttingDown) installCap(recording); }
  };
  const dispose = (): Promise<void> => {
    if (disposingPromise != null) return disposingPromise; shuttingDown = true;
    const teardown = (async (): Promise<void> => { try { if (startingRecording != null) try { await startingRecording; } catch { await recoverBrokenStart(); } if (stoppingRecording != null) try { await stoppingRecording; } catch { if (active != null && !queuedOnBox) await stop({ agentId: active.agentId, save: false, trackCompletion: false }); } else if (active != null && !queuedOnBox) await stop({ agentId: active.agentId, save: false, trackCompletion: false }); } finally { releaseCap(); subscribers.clear(); } })();
    disposingPromise = teardown; return teardown;
  };
  return { api: { start, stop: ({ agentId, save }: { agentId: string; save: boolean }) => stop({ agentId, save, trackCompletion: true }), getStatus: currentStatus, subscribe(listener: (status: TeachStatus) => void) { subscribers.add(listener); return () => subscribers.delete(listener); } }, recoverPending: recoverPendingRecordings, dispose };
}

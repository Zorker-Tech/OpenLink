import { defineHostExtension, type HostExtensionContext } from "../../extensions/host-extensions.ts";
import { createDeadlinePolicy, createExpiryPolicy, createPollingPolicy, createRetryPolicy, realClock } from "../../extensions/scheduling.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { isSlatePackaged } from "../../../shared/node/slate-variant.ts";
import { formatBoxStartupSummary } from "../box-factory.ts";
import { isBoxStoreCopyInEnabled, isBoxStoreSyncEnabled } from "../box-store-backend-policy.ts";
import { provisionBoxPromptArtifacts } from "../../runner/box-reference-docs.ts";
import { HostExtensions } from "../../extensions/extension-ids.generated.ts";
import { startDiskPressureWatch, type DiskPressureWatch } from "./disk-pressure.ts";
import {
  FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS,
  FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS,
  FOREVER_BOX_MIGRATION_TTL_MS,
  FOREVER_BOX_RECREATE_FLUSH_WAIT_MS,
  FOREVER_BOX_SCREENSHOT_TIMEOUT_MS,
  ForeverBoxService,
  type ForeverBoxOptions,
} from "./forever-box-service.ts";
import { HostBox } from "./host-box.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { createProductionBoxInner, type ErasedProductionBoxGeneratedPorts } from "../production.ts";
import type { LoopbackTelemetry } from "../loopback-slate-box.ts";

interface ForeverHost {
  log(message: string): void;
  boxGenerated: ErasedProductionBoxGeneratedPorts;
  standaloneBoxExecDaemon?: boolean;
}

type ExtensionStartContext = HostExtensionContext<ForeverHost>;
type BoxTelemetryLogs = ForeverBoxOptions["telemetry"] & {
  reportBoxDiskPressure(value: Record<string, unknown>): void;
};
type BoxTelemetry = { brain: LoopbackTelemetry; logs: BoxTelemetryLogs };

interface ImageWatchSchedule {
  readonly intervalMs: number;
  readonly jitterRatio: number;
  readonly initialDelayMs: number;
  readonly pollingIntervalMs: number;
}

function updateWasDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.SLATE_BOX_AUTO_UPDATE?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "no";
}

export function isImageAutoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isBoxStoreSyncEnabled(env) && isBoxStoreCopyInEnabled(env) && !updateWasDisabled(env);
}

export function isHostBundleAutoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !updateWasDisabled(env);
}

export function imageWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.SLATE_BOX_UPDATE_WATCH_INTERVAL_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS;
}

export function imageWatchJitterRatio(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseFloat(env.SLATE_BOX_UPDATE_WATCH_JITTER_RATIO ?? "");
  if (!Number.isFinite(parsed) || parsed < 0) return 0.5;
  return Math.min(1, parsed);
}

export function initialImageWatchDelayMs(
  schedule: { readonly intervalMs: number; readonly ratio: number },
  random: () => number = Math.random,
): number {
  if (schedule.ratio <= 0) return 0;
  return Math.round(random() * schedule.intervalMs);
}

export function jitteredImageWatchIntervalMs(
  schedule: { readonly intervalMs: number; readonly ratio: number },
  random: () => number = Math.random,
): number {
  if (schedule.ratio <= 0) return schedule.intervalMs;
  const radius = schedule.intervalMs * schedule.ratio;
  const sample = random();
  return Math.max(1, Math.round(schedule.intervalMs - radius + sample * radius * 2));
}

function imageWatchSchedule(): ImageWatchSchedule {
  const intervalMs = imageWatchIntervalMs();
  const jitterRatio = imageWatchJitterRatio();
  return {
    intervalMs,
    jitterRatio,
    initialDelayMs: initialImageWatchDelayMs({ intervalMs, ratio: jitterRatio }),
    pollingIntervalMs: jitteredImageWatchIntervalMs({ intervalMs, ratio: jitterRatio }),
  };
}

function telemetryFor(context: ExtensionStartContext): BoxTelemetry {
  return context.deps[HostExtensions.Telemetry] as BoxTelemetry;
}

function createBoxRuntime(context: ExtensionStartContext, telemetry: BoxTelemetry) {
  return createProductionBoxInner({
    generated: context.host.boxGenerated,
    telemetry: telemetry.brain,
    protectedBoxPaths: [getSlateRootDir()],
    sharedDesktop: context.host.standaloneBoxExecDaemon !== true,
  });
}

function serviceOptions(
  context: ExtensionStartContext,
  box: HostBox,
  telemetry: BoxTelemetry,
  schedule: ImageWatchSchedule,
  autoUpdateEnabled: boolean,
): ForeverBoxOptions {
  const lifecycleClient = context.deps[HostExtensions.BoxLifecycle] as ForeverBoxOptions["lifecycleClient"];
  const trays = context.deps[HostExtensions.Trays] as ForeverBoxOptions["trays"];
  const codebaseTelemetry = context.deps[HostExtensions.CodebaseTelemetry] as {
    flushPendingUploads(): Promise<void>;
  };

  return {
    box,
    lifecycleClient,
    trays,
    telemetry: telemetry.logs,
    imagePolling: createPollingPolicy(realClock, {
      name: "slate-forever-box-image-watch",
      intervalMs: schedule.pollingIntervalMs,
    }),
    imagePollingStartDelay: createRetryPolicy(realClock, {
      name: "slate-forever-box-image-watch-start",
      maxAttempts: 2,
      initialDelayMs: schedule.initialDelayMs,
      maxDelayMs: schedule.initialDelayMs,
    }),
    imageSeedRetry: createRetryPolicy(realClock, {
      name: "slate-forever-box-image-seed",
      maxAttempts: 3,
      initialDelayMs: 15_000,
      maxDelayMs: 60_000,
      backoffFactor: 4,
    }),
    imageCheckDeadline: createDeadlinePolicy(realClock, {
      name: "slate-forever-box-image-check",
      timeoutMs: FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS,
    }),
    migrationExpiry: createExpiryPolicy(realClock, {
      name: "slate-forever-box-migration",
      ttlMs: FOREVER_BOX_MIGRATION_TTL_MS,
    }),
    screenshotDeadline: createDeadlinePolicy(realClock, {
      name: "slate-forever-box-handoff-screenshot",
      timeoutMs: FOREVER_BOX_SCREENSHOT_TIMEOUT_MS,
    }),
    recreateFlushWaitDeadline: createDeadlinePolicy(realClock, {
      name: "slate-forever-box-recreate-flush-wait",
      timeoutMs: FOREVER_BOX_RECREATE_FLUSH_WAIT_MS,
    }),
    flushPendingUploads: () => codebaseTelemetry.flushPendingUploads(),
    autoUpdateEnabled,
    hostBundleAutoUpdateEnabled: isHostBundleAutoUpdateEnabled(),
    isInBox: () => process.env.SLATE_HOST_IN_BOX === "1",
    log: (message) => context.host.log(message),
  };
}

function startBoxDiskPressureWatch(context: ExtensionStartContext, telemetry: BoxTelemetry): DiskPressureWatch {
  return startDiskPressureWatch({
    polling: createPollingPolicy(realClock, {
      name: "slate-forever-box-disk-pressure",
      intervalMs: 60_000,
    }),
    report: (report) => telemetry.logs.reportBoxDiskPressure({ ...report }),
    isInBox: process.env.SLATE_HOST_IN_BOX === "1",
    log: (message) => context.host.log(message),
  });
}

function provisionPromptsInsideBox(context: ExtensionStartContext): void {
  if (process.env.SLATE_HOST_IN_BOX !== "1") return;
  void provisionBoxPromptArtifacts().catch((error: unknown) => {
    context.host.log("Box prompt setup did not finish: " + errorMessage(error));
  });
}

function hostApi(service: ForeverBoxService, diskPressure: DiskPressureWatch) {
  return {
    box: service.box,
    isAutoUpdateEnabled: service.isAutoUpdateEnabled,
    get diskPressureLevel() {
      return diskPressure.level;
    },
    diskPressureReminder: diskPressure.reminderEpisodes,
    subscribeToDiskPressure: (listener: (level: "soft" | "hard" | null) => void) => diskPressure.subscribe(listener),
    getStatus: (input: { id: string }) => service.getStatus(input),
    ensure: (input: { id: string }) => service.ensure(input),
    reset: (input: { id: string }) => service.reset(input),
    update: (input: { id: string; force?: boolean }) => service.update(input),
    autoUpdateNow: () => service.autoUpdateNow(),
    setMigrating: (input: { migrating: boolean }) => service.setMigrating(input),
    subscribe: (listener: Parameters<typeof service.subscribe>[0]) => service.subscribe(listener),
    releaseAgent: (id: string) => service.releaseAgent(id),
    captureScreenshot: (id: string) => service.captureScreenshot(id),
    setBusy: (busy: boolean) => service.setBusy(busy),
  };
}

export function createForeverBoxExtension() {
  return defineHostExtension<unknown, ForeverHost>({
    id: HostExtensions.ForeverBox,
    dependencies: [
      HostExtensions.BoxLifecycle,
      HostExtensions.CodebaseTelemetry,
      HostExtensions.Telemetry,
      HostExtensions.Trays,
    ],
    start(context) {
      const autoUpdateEnabled = isImageAutoUpdateEnabled();
      const schedule = imageWatchSchedule();
      const telemetry = telemetryFor(context);
      const boxRuntime = createBoxRuntime(context, telemetry);
      const box = new HostBox(boxRuntime);
      const service = new ForeverBoxService(serviceOptions(
        context,
        box,
        telemetry,
        schedule,
        autoUpdateEnabled,
      ));

      context.onStop(() => boxRuntime.dispose());
      context.onStop(() => service.dispose());
      service.start();
      context.host.log(formatBoxStartupSummary({
        autoUpdateEnabled,
        isPackaged: isSlatePackaged(),
      }).replace("[slate-host] ", ""));

      const diskPressure = startBoxDiskPressureWatch(context, telemetry);
      context.onStop(() => diskPressure.dispose());
      provisionPromptsInsideBox(context);
      return hostApi(service, diskPressure);
    },
  });
}

export const foreverBoxExtension = createForeverBoxExtension();

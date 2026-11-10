/** Cloud-agent completions and local-shell terminal files watched after a turn ends. */
import { decodeBackgroundWorkMetadata } from "../../packages/agent-exec/background-work-metadata.ts";
import { RevivingBackgroundWorkRegistry } from "./background-work-registry.ts";
import type { BackgroundWorkFilter, BackgroundWakeup, BackgroundWatchesHost } from "./background-work-contracts.ts";

interface CloudWatch {
  title: string;
  startedAtMs: number;
}

interface ShellWatch {
  cancel(): void;
  title: string;
  startedAtMs: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settledShellNotice(
  host: BackgroundWatchesHost,
  item: BackgroundWakeup["payload"],
  quietOrigin: string | undefined,
): void {
  host.backgroundShellSettledHandler()?.({
    agentId: host.getConversationId(),
    shellId: item.taskId,
    title: item.title,
    status: item.status,
    detail: item.detail,
    outputPath: item.outputPath,
    ...(quietOrigin == null ? {} : { quietOrigin }),
  });
}

export function createBackgroundWatches(host: BackgroundWatchesHost) {
  const cloudWatches = new Map<string, CloudWatch>();
  const shellWatches = new Map<string, ShellWatch>();
  let registryValue: RevivingBackgroundWorkRegistry | undefined;

  const cancelShell = (workId: string): void => {
    shellWatches.get(workId)?.cancel();
  };

  const registry = (): RevivingBackgroundWorkRegistry => {
    if (registryValue !== undefined) return registryValue;
    registryValue = new RevivingBackgroundWorkRegistry(
      (item, quietOrigin) => settledShellNotice(host, item, quietOrigin),
      (item, quietOrigin) => {
        cancelShell(item.id);
        const data = typeof item.metadata === "object" && item.metadata !== null && !Array.isArray(item.metadata)
          ? Object.fromEntries(Object.entries(item.metadata))
          : undefined;
        const title = decodeBackgroundWorkMetadata(data).title ?? `Background command ${item.id}`;
        host.pendingWakeArmedHandler()?.({
          parentAgentId: host.getConversationId(),
          kind: "shell",
          workId: item.id,
          title,
          ...(quietOrigin == null ? {} : { quietOrigin }),
        });
      },
      () => host.emitAsyncTasksChanged(),
    );
    return registryValue;
  };

  const watchCloudAgent = (agentId: string, options?: { quietOrigin?: string; afterFollowup?: boolean }): void => {
    const id = agentId.trim();
    const watcher = host.cloudAgentWatcher();
    if (id.length === 0 || watcher === null || cloudWatches.has(id)) return;

    const title = `Cloud agent ${id}`;
    const watch: CloudWatch = { title, startedAtMs: Date.now() };
    cloudWatches.set(id, watch);
    host.pendingWakeArmedHandler()?.({
      parentAgentId: host.getConversationId(),
      kind: "cloud-agent",
      workId: id,
      title,
      ...(options?.quietOrigin == null ? {} : { quietOrigin: options.quietOrigin }),
    });
    host.emitAsyncTasksChanged();

    const completionContext = {
      parentAgentId: host.getConversationId(),
      subagentAgentId: id,
      subagentType: "slate-agent",
      toolCallId: "",
      title,
      ...(options?.quietOrigin == null ? {} : { quietOrigin: options.quietOrigin }),
    };
    const clearIfCurrent = (): boolean => {
      if (cloudWatches.get(id) !== watch) return false;
      cloudWatches.delete(id);
      host.emitAsyncTasksChanged();
      return true;
    };

    void watcher.awaitCompletion(id, { waitForRestart: options?.afterFollowup ?? false }).then(
      result => {
        if (!clearIfCurrent()) return;
        host.notifyBackgroundWorkSettled({
          ...completionContext,
          status: result.status === "error" ? "error" : "completed",
          result: result.text.trim() || "(the cloud agent finished without producing any output)",
        });
      },
      error => {
        if (!clearIfCurrent()) return;
        host.notifyBackgroundWorkSettled({ ...completionContext, status: "error", result: errorText(error) });
      },
    );
  };

  const watchBackgroundShell = (shellId: string, options?: { title?: string; quietOrigin?: string }): void => {
    const id = shellId.trim();
    if (id.length === 0) return;

    const title = options?.title ?? `Background command ${id}`;
    host.pendingWakeArmedHandler()?.({
      parentAgentId: host.getConversationId(),
      kind: "shell",
      workId: id,
      title,
      ...(options?.quietOrigin == null ? {} : { quietOrigin: options.quietOrigin }),
    });
    if (shellWatches.has(id) || registry().listWork({ kind: "shell" }).some(item => item.id === id)) return;

    let cancelled = false;
    const watch: ShellWatch = {
      title,
      startedAtMs: Date.now(),
      cancel() {
        cancelled = true;
        shellWatches.delete(id);
        host.emitAsyncTasksChanged();
      },
    };
    shellWatches.set(id, watch);
    host.emitAsyncTasksChanged();
    host.pollShellTerminalFile(id, () => cancelled, (status, detail, outputPath) => {
      if (cancelled) return;
      shellWatches.delete(id);
      host.emitAsyncTasksChanged();
      host.backgroundShellSettledHandler()?.({
        agentId: host.getConversationId(),
        shellId: id,
        title,
        status,
        detail,
        outputPath,
        ...(options?.quietOrigin == null ? {} : { quietOrigin: options.quietOrigin }),
      });
    });
  };

  const cancelBackgroundShellRewatches = (): void => {
    for (const watch of shellWatches.values()) watch.cancel();
    shellWatches.clear();
  };

  const cancelBackgroundWatches = (): void => {
    cancelBackgroundShellRewatches();
    registryValue?.abortAllWork({ kind: "shell" });
    cloudWatches.clear();
    host.emitAsyncTasksChanged();
  };

  return {
    registry,
    listRegisteredShellWork: (filter?: BackgroundWorkFilter) => registryValue?.listWork(filter),
    watchCloudAgent,
    watchBackgroundShell,
    pendingCloudAgentWatchBcIds: () => [...cloudWatches.keys()],
    pendingShellRewatchIds: () => [...shellWatches.keys()],
    hasRunningBackgroundShellWork: () => shellWatches.size > 0 || (registryValue?.hasRunningWork({ kind: "shell" }) ?? false),
    cancelBackgroundShellRewatches,
    cancelBackgroundWatches,
    shellRewatchEntries: () => shellWatches.entries(),
    cloudAgentWatchEntries: () => cloudWatches.entries(),
  };
}

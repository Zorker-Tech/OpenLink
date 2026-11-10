import type { BoxConnection, BoxStatus } from "./host-box-contracts.ts";

type StatusListener = (status: BoxStatus) => void;

/** The host's cached view of desktop connections, fork windows, and image availability. */
export class HostBoxStatusState {
  private readonly mainWindowUrlByAgent = new Map<string, string>();
  private readonly forkWindowUrlsByAgent = new Map<string, Map<number, string>>();
  readonly vncUrls = this.mainWindowUrlByAgent;
  readonly forkVncUrls = this.forkWindowUrlsByAgent;
  private readonly observers = new Set<StatusListener>();
  private readonly reportedStatusByAgent = new Map<string, BoxStatus>();
  private readonly connectionGenerationByAgent = new Map<string, number>();
  private cachedImageAvailability: boolean | undefined;

  subscribe(listener: StatusListener): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  buildWindows(agentId: string): Array<{ windowIndex: number; vncUrl: string }> | undefined {
    const mainUrl = this.mainWindowUrlByAgent.get(agentId);
    const forkUrls = this.forkWindowUrlsByAgent.get(agentId);
    if (mainUrl == null && (forkUrls == null || forkUrls.size === 0)) return undefined;

    const windows: Array<{ windowIndex: number; vncUrl: string }> = [];
    if (mainUrl != null) windows.push({ windowIndex: 0, vncUrl: mainUrl });
    const forkIndices = [...(forkUrls?.keys() ?? [])].sort((left, right) => left - right);
    for (const windowIndex of forkIndices) {
      const url = forkUrls?.get(windowIndex);
      if (url != null) windows.push({ windowIndex, vncUrl: url });
    }
    return windows;
  }

  recordConnection(agentId: string, connection: BoxConnection): void {
    this.mainWindowUrlByAgent.set(agentId, connection.vncUrl);
    this.connectionGenerationByAgent.set(agentId, (this.connectionGenerationByAgent.get(agentId) ?? 0) + 1);
    if (connection.imageUpdateAvailable !== undefined) this.cachedImageAvailability = connection.imageUpdateAvailable;
  }

  recordImageUpdateAvailable(value: boolean | undefined): void {
    if (value === undefined || value === this.cachedImageAvailability) return;
    this.cachedImageAvailability = value;

    for (const agentId of this.reportedStatusByAgent.keys()) {
      const mainUrl = this.mainWindowUrlByAgent.get(agentId);
      const previous = this.reportedStatusByAgent.get(agentId);
      if (mainUrl != null) this.publishStatus(this.runningStatus(agentId, mainUrl));
      else if (previous != null) this.publishStatus({ ...previous, imageUpdateAvailable: value });
    }
  }

  runningStatus(agentId: string, vncUrl: string): BoxStatus {
    const windows = this.buildWindows(agentId);
    return {
      agentId,
      state: "running",
      vncUrl,
      ...(windows === undefined ? {} : { windows }),
      ...(this.cachedImageAvailability === undefined ? {} : { imageUpdateAvailable: this.cachedImageAvailability }),
    };
  }

  getImageUpdateAvailable(): boolean | undefined {
    return this.cachedImageAvailability;
  }

  hasMainWindow(agentId: string): boolean { return this.mainWindowUrlByAgent.has(agentId); }
  mainWindowUrl(agentId: string): string | undefined { return this.mainWindowUrlByAgent.get(agentId); }
  setMainWindowUrl(agentId: string, url: string): void { this.mainWindowUrlByAgent.set(agentId, url); }
  recordForkWindow(agentId: string, windowIndex: number, url: string): void {
    const windows = this.forkWindowUrlsByAgent.get(agentId) ?? new Map<number, string>();
    windows.set(windowIndex, url);
    this.forkWindowUrlsByAgent.set(agentId, windows);
  }

  report(status: BoxStatus): BoxStatus {
    this.reportedStatusByAgent.set(status.agentId, status);
    return status;
  }

  publishStatus(status: BoxStatus): void {
    this.reportedStatusByAgent.set(status.agentId, status);
    for (const listener of this.observers) listener(status);
  }

  clearWindowUrls(agentId: string): void {
    this.mainWindowUrlByAgent.delete(agentId);
    this.forkWindowUrlsByAgent.delete(agentId);
  }

  connectionGeneration(agentId: string): number {
    return this.connectionGenerationByAgent.get(agentId) ?? 0;
  }

  finishRelease(agentId: string, startingGeneration: number): boolean {
    if (this.connectionGeneration(agentId) !== startingGeneration) return false;
    this.clearWindowUrls(agentId);
    this.connectionGenerationByAgent.delete(agentId);
    this.publishStatus({ agentId, state: "absent", vncUrl: null });
    this.reportedStatusByAgent.delete(agentId);
    return true;
  }
}

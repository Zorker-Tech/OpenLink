import { promises as fs } from "node:fs";

export const UA_TOKEN_DISABLED_MARKER_PATH = "/tmp/slate-ua-token-disabled";

interface MarkerReconciliationOptions {
  readonly path?: string;
  readonly isKillSwitchEnabled: () => boolean;
  readonly log: (message: string) => void;
}

interface ResolvedMarkerOptions {
  readonly path: string;
  readonly isKillSwitchEnabled: () => boolean;
  readonly log: (message: string) => void;
}

class MarkerReconciliationQueue {
  private appliedState: boolean | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ResolvedMarkerOptions) {}

  schedule(): Promise<void> {
    this.tail = this.tail.then(() => this.reconcileCurrentState());
    return this.tail;
  }

  private async reconcileCurrentState(): Promise<void> {
    const disabled = this.options.isKillSwitchEnabled();
    if (disabled === this.appliedState) return;

    try {
      await this.updateMarker(disabled);
      this.appliedState = disabled;
    } catch (error) {
      this.options.log(`ua-token kill-switch marker update failed: ${String(error)}`);
    }
  }

  private updateMarker(disabled: boolean): Promise<void> {
    if (!disabled) return fs.rm(this.options.path, { force: true });
    return fs.writeFile(this.options.path, "1\n", { encoding: "utf8", mode: 0o644 });
  }
}

export function createUaTokenKillSwitchReconciler(options: MarkerReconciliationOptions): () => Promise<void> {
  const queue = new MarkerReconciliationQueue({
    path: options.path ?? UA_TOKEN_DISABLED_MARKER_PATH,
    isKillSwitchEnabled: options.isKillSwitchEnabled,
    log: options.log,
  });
  return () => queue.schedule();
}

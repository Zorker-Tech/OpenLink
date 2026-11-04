import type { McpAccountConfigProvider, McpRuntimeConfig } from "./mcp-definition-source-contracts.ts";

export class McpAccountConfigCache {
  private currentLoad: Promise<McpRuntimeConfig | null>;
  private generation = 0;
  private lastSuccessfulConfig: McpRuntimeConfig | null = null;

  constructor(private readonly provider?: McpAccountConfigProvider) {
    this.currentLoad = this.startLoad();
  }

  get current(): Promise<McpRuntimeConfig | null> {
    return this.currentLoad;
  }

  get lastKnown(): McpRuntimeConfig | null {
    return this.lastSuccessfulConfig;
  }

  private startLoad(): Promise<McpRuntimeConfig | null> {
    const requestGeneration = ++this.generation;
    const pending = this.provider?.() ?? Promise.resolve(null);
    void pending.then((config) => {
      if (config != null && requestGeneration === this.generation) this.lastSuccessfulConfig = config;
    }, () => undefined);
    return pending;
  }

  clearLastKnown(): void {
    this.generation += 1;
    this.lastSuccessfulConfig = null;
    this.currentLoad = Promise.resolve(null);
  }

  adopt(config: McpRuntimeConfig | null): void {
    this.generation += 1;
    this.lastSuccessfulConfig = config;
    this.currentLoad = Promise.resolve(config);
  }

  reload(): void {
    this.currentLoad = this.startLoad();
  }

  async ensureLoaded(): Promise<void> {
    this.reload();
    if (await this.currentLoad.catch(() => null) != null) return;
    this.reload();
    if (await this.currentLoad.catch(() => null) == null && this.lastSuccessfulConfig != null) {
      this.currentLoad = Promise.resolve(this.lastSuccessfulConfig);
    }
  }

  refreshInBackground(): void {
    const requestAtStart = this.currentLoad;
    void this.startLoad().then((config) => {
      if (config != null && this.currentLoad === requestAtStart) this.currentLoad = Promise.resolve(config);
    }, () => undefined);
  }
}

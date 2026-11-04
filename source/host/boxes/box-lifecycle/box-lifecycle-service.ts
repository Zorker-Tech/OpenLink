/** Host-facing actions for checking and rebuilding the managed box. */

export interface BoxLifecycleOutcome {
  readonly started: boolean;
  readonly reason?: string;
}

export interface BoxLifecycleBackend {
  imageUpdateAvailable(signal: AbortSignal): Promise<boolean>;
  recreate(input: { readonly preserveData: boolean; readonly force: boolean }): Promise<BoxLifecycleOutcome>;
}

export class BoxLifecycleService {
  constructor(private readonly backend: BoxLifecycleBackend) {}

  async fetchImageUpdateAvailable(signal: AbortSignal): Promise<boolean> {
    return await this.backend.imageUpdateAvailable(signal);
  }

  async recreateInBox(options: { readonly preserveData: boolean; readonly force?: boolean }): Promise<BoxLifecycleOutcome> {
    return await this.backend.recreate({
      preserveData: options.preserveData,
      force: options.force === true,
    });
  }
}

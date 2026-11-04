import { getSlateRootDir } from "../../host-paths.ts"
import { SlateExperimentService } from "../../../shared/node/experiments/slate-experiment-service.ts"

export interface ExperimentsAuthPort {
  getAccessToken(options: { readonly backendUrl: string }): Promise<string>
  getMachineId(): Promise<string>
  peekAccessToken(): string | null
  subscribeToRenewal(listener: (event: { outcome: string; isFirstCredential: boolean }) => void): () => void
}

export interface ExperimentsSettingsPort {
  subscribeToFeatureFlagOverrides(listener: (overrides: Record<string, boolean>) => void): () => void
}

export interface StartExperimentsServiceOptions {
  readonly auth: ExperimentsAuthPort
  readonly settings: ExperimentsSettingsPort
  readonly onStop: (teardown: () => void) => void
  readonly environment?: NodeJS.ProcessEnv
}

export function startExperimentsService(options: StartExperimentsServiceOptions): SlateExperimentService {
  const environment = options.environment ?? process.env
  const service = new SlateExperimentService({
    getAccessToken: options.auth.getAccessToken,
    getMachineId: options.auth.getMachineId,
    getCacheDir: () => getSlateRootDir(),
    isDevBuild: environment.SLATE_PACKAGED !== "1" || environment.SLATE_HOST_DEV_ERROR_DETAIL === "1",
  })
  service.start()
  options.onStop(() => service.dispose())
  options.onStop(options.auth.subscribeToRenewal(event => {
    if (event.outcome === "renewed" && (event.isFirstCredential || !service.hasAuthenticatedBootstrap())) {
      service.handleAuthChange()
    }
  }))
  if (options.auth.peekAccessToken() !== null) service.handleAuthChange()
  options.onStop(options.settings.subscribeToFeatureFlagOverrides(overrides => {
    service.replaceFeatureFlagOverrides(overrides)
  }))
  return service
}

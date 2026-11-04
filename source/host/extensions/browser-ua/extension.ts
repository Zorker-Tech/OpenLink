import { defineHostExtension, type HostExtensionContext } from "../host-extensions.ts"
import { HostExtensions } from "../extension-ids.generated.ts"
import { createUaOwnerStampWriter } from "./ua-owner-stamp-service.ts"
import { createUaTokenKillSwitchReconciler } from "./ua-token-kill-switch-service.ts"

interface AuthApi {
  peekAccessToken(): string | null
  subscribeToRenewal(listener: (event: { outcome: string }) => void): () => void
}

interface ExperimentsApi {
  isUaTokenKillSwitchEnabled(): boolean
  subscribe(listener: () => void): () => void
}

type BrowserUaHost = { readonly log: (message: string) => void }

export interface BrowserUaExtensionFactories {
  readonly createOwnerStampWriter?: typeof createUaOwnerStampWriter
  readonly createKillSwitchReconciler?: typeof createUaTokenKillSwitchReconciler
}

function registerOwnerStamp(
  context: HostExtensionContext<BrowserUaHost>,
  auth: AuthApi,
  createWriter: typeof createUaOwnerStampWriter,
): void {
  const writeOwnerStamp = createWriter({ log: (message) => context.host.log(message) })
  const unsubscribe = auth.subscribeToRenewal((event) => {
    if (event.outcome === "renewed") void writeOwnerStamp(auth.peekAccessToken())
  })
  context.onStop(unsubscribe)

  if (auth.peekAccessToken() !== null) void writeOwnerStamp(auth.peekAccessToken())
}

function registerKillSwitch(
  context: HostExtensionContext<BrowserUaHost>,
  experiments: ExperimentsApi,
  createReconciler: typeof createUaTokenKillSwitchReconciler,
): void {
  const reconcile = createReconciler({
    isKillSwitchEnabled: () => experiments.isUaTokenKillSwitchEnabled(),
    log: (message) => context.host.log(message),
  })
  const unsubscribe = experiments.subscribe(() => { void reconcile() })
  context.onStop(unsubscribe)
  void reconcile()
}

export function createBrowserUaExtension(factories: BrowserUaExtensionFactories = {}) {
  const createStamp = factories.createOwnerStampWriter ?? createUaOwnerStampWriter
  const createReconciler = factories.createKillSwitchReconciler ?? createUaTokenKillSwitchReconciler

  return defineHostExtension<{}, BrowserUaHost>({
    id: HostExtensions.BrowserUa,
    dependencies: [HostExtensions.Auth, HostExtensions.Experiments],
    start(context) {
      const auth = context.deps[HostExtensions.Auth] as AuthApi
      const experiments = context.deps[HostExtensions.Experiments] as ExperimentsApi
      registerOwnerStamp(context, auth, createStamp)
      registerKillSwitch(context, experiments, createReconciler)
      return {}
    },
  })
}

export const browserUaExtension = createBrowserUaExtension()

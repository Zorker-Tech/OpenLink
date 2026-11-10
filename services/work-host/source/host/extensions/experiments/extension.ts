import { HostExtensions } from "../extension-ids.generated.ts"
import { defineHostExtension } from "../host-extensions.ts"
import { createExperimentsExtensionApi } from "./experiments-extension-api.ts"
import {
  startExperimentsService,
  type ExperimentsAuthPort,
  type ExperimentsSettingsPort,
} from "./experiments-extension-lifecycle.ts"

export const experimentsExtension = defineHostExtension({
  id: HostExtensions.Experiments,
  dependencies: [HostExtensions.Auth, HostExtensions.Settings],
  start(context) {
    const auth = context.deps[HostExtensions.Auth] as ExperimentsAuthPort
    const settings = context.deps[HostExtensions.Settings] as ExperimentsSettingsPort
    const service = startExperimentsService({
      auth,
      settings,
      onStop: teardown => context.onStop(teardown),
    })
    return createExperimentsExtensionApi(service)
  },
})

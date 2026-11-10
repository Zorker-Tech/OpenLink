/** Register box lifecycle actions using the host's authenticated backend port. */

import { createBoxLifecycleBackend, type BoxLifecycleAuth } from "../../../adapters/interop/agent/box-lifecycle-backend-adapter.ts";
import { HostExtensions } from "../../extensions/extension-ids.generated.ts";
import { defineHostExtension } from "../../extensions/host-extensions.ts";
import { BoxLifecycleService } from "./box-lifecycle-service.ts";

export const boxLifecycleExtension = defineHostExtension({
  id: HostExtensions.BoxLifecycle,
  dependencies: [HostExtensions.Auth],
  start(context) {
    const auth = context.deps[HostExtensions.Auth] as BoxLifecycleAuth;
    return new BoxLifecycleService(createBoxLifecycleBackend(auth));
  },
});

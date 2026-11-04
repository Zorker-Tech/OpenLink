/**
 * Notifications, declared as a host extension.
 *
 * Starting it builds the notification service over the host's own pieces, so a surface can be told what happened
 * without knowing how notification is carried.
 */
import { createSlateMobilePushAdapter } from "../../adapters/interop/cursor-backend/mobile-push-adapter.ts";
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { SlateMobilePushNotifier } from "./mobile-push-notifier.ts";
import { dispatchNotificationHostEvent, type NotificationHostEvent } from "./event-routing.ts";
interface NotificationHost { readonly events: { subscribe(listener: (event: NotificationHostEvent) => void): () => void }; }
export const notificationsExtension = defineHostExtension<{}, NotificationHost>({
  id: HostExtensions.Notifications,
  dependencies: [HostExtensions.Auth],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as {
      getAccessToken(options: { backendUrl: string }): Promise<string>
      getMachineId(): Promise<string>
    }
    const notifier = new SlateMobilePushNotifier({ notify: createSlateMobilePushAdapter(auth) })
    const unsubscribe = context.host.events.subscribe((event) => dispatchNotificationHostEvent(notifier, event))
    context.onStop(unsubscribe)
    return {}
  },
})

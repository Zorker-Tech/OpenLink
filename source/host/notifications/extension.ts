/**
 * Notifications, declared as a host extension.
 *
 * Starting it builds the notification service over the host's own pieces, so a surface can be told what happened
 * without knowing how notification is carried.
 */
import { defineHostExtension } from "../extensions/host-extensions.ts"; import { SlateBotService } from "../../packages/proto/generated/aiserver/v1/slate_bot_connect.ts"; import { createSlateCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.ts"; import type { NotificationAgent } from "../../shared/os-notification.ts"; import { HostExtensions } from "../extensions/extension-ids.generated.ts"; import { SlateMobilePushNotifier, createSlateMobilePushSender } from "./mobile-push-notifier.ts";
type NotificationHostEvent =
  | { readonly kind: "notification-baseline"; readonly agents: readonly NotificationAgent[] }
  | { readonly kind: "notification-agents"; readonly event: { readonly agents: readonly NotificationAgent[] }; readonly presence: { readonly windowFocusedAtMs?: number | null } }
  | { readonly kind: "notification-agent-upserted"; readonly event: { readonly agent: NotificationAgent }; readonly presence: { readonly windowFocusedAtMs?: number | null } }
  | { readonly kind: "notification-agent-forgotten"; readonly agentId: string };
interface NotificationHost { readonly events: { subscribe(listener: (event: NotificationHostEvent) => void): () => void }; }
export const notificationsExtension = defineHostExtension<{}, NotificationHost>({ id: HostExtensions.Notifications, dependencies: [HostExtensions.Auth], start: (context) => { const auth = context.deps[HostExtensions.Auth] as { getAccessToken(options: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string> }; const client = createSlateCursorBackendClient(SlateBotService, { getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId }); const notifier = new SlateMobilePushNotifier({ notify: createSlateMobilePushSender(client as unknown as Parameters<typeof createSlateMobilePushSender>[0]) }); const unsubscribe = context.host.events.subscribe((event) => { switch (event.kind) { case "notification-baseline": notifier.seedBaseline(event.agents); break; case "notification-agents": notifier.handleAgentsEvent(event.event, event.presence); break; case "notification-agent-upserted": notifier.handleAgentUpsertedEvent(event.event, event.presence); break; case "notification-agent-forgotten": notifier.forget(event.agentId); } }); context.onStop(unsubscribe); return {}; } });

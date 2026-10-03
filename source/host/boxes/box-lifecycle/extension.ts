/**
 * The box lifecycle, declared as a host extension.
 *
 * Starting it builds the lifecycle service over the host's auth, talking to the backend on the host's own account.
 */
import { defineHostExtension } from "../../extensions/host-extensions.ts"; import { SlateBotService } from "../../../packages/proto/generated/aiserver/v1/slate_bot_connect.ts"; import { createSlateCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.ts"; import { HostExtensions } from "../../extensions/extension-ids.generated.ts"; import { BoxLifecycleService, type BoxLifecycleClient } from "./box-lifecycle-service.ts";
interface AuthApi { getAccessToken(options: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string>; }
export const boxLifecycleExtension = defineHostExtension({ id: HostExtensions.BoxLifecycle, dependencies: [HostExtensions.Auth], start: (context) => { const auth = context.deps[HostExtensions.Auth] as AuthApi; const client = createSlateCursorBackendClient(SlateBotService, { getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId }); return new BoxLifecycleService(client as unknown as BoxLifecycleClient); } });

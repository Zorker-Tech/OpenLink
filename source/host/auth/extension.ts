/**
 * The account, declared as a host extension.
 *
 * Starting it builds the account service on the platform's own retry and clock, and keeps the name the account goes
 * by beside it: the name is read again whenever a credential is renewed, and once at startup when a credential is
 * already there. What the rest of the host gets is this surface and nothing else — the credential, its renewals, the
 * machine identity and the name.
 */

import { createRealRetryPolicy, realClock } from "../extensions/scheduling.ts";
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { createHostAuthService } from "./auth-service.ts";
import { CREDENTIAL_RETRY_BASE_DELAY_MS, CREDENTIAL_RETRY_MAX_DELAY_MS } from "./credential-renewer.ts";
import { createSlateUserFullNameResolver } from "./user-full-name-service.ts";

interface AuthExtensionHost {
  log(message: string): void;
}

export const authExtension = defineHostExtension({
  id: HostExtensions.Auth,
  dependencies: [],
  start: (context) => {
    const host = context.host as AuthExtensionHost;
    const log = (message: string): void => host.log(message);
    const account = createHostAuthService({
      retry: createRealRetryPolicy({ name: "slate-inference-credential-renewal", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: CREDENTIAL_RETRY_BASE_DELAY_MS, maxDelayMs: CREDENTIAL_RETRY_MAX_DELAY_MS }),
      clock: realClock,
      log,
    });
    context.onStop(() => account.dispose());
    const fullName = createSlateUserFullNameResolver({
      getAccessToken: (options) => account.getAccessToken(options),
      peekAccessToken: () => account.peekAccessToken(),
      getMachineId: () => account.getMachineId(),
      log,
    });
    // A renewed credential may belong to someone else by now, so the name is read again with it.
    context.onStop(account.subscribeToRenewal((event) => {
      if (event.outcome === "renewed") void fullName.refresh();
    }));
    if (account.peekAccessToken() !== null) void fullName.refresh();
    return {
      getAccessToken: (options: { readonly backendUrl?: string }) => account.getAccessToken(options),
      peekAccessToken: () => account.peekAccessToken(),
      getLastRenewalEvent: () => account.getLastRenewalEvent(),
      getMachineId: () => account.getMachineId(),
      subscribeToRenewal: (listener: Parameters<typeof account.subscribeToRenewal>[0]) => account.subscribeToRenewal(listener),
      getUserFullName: () => fullName.getUserFullName(),
    };
  },
});

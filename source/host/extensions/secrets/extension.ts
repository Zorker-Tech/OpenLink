/** The secrets store as a host extension: the applier is wired here, with the store it writes through. */
import { createDeadlinePolicy, createRetryPolicy, realClock } from "../scheduling.ts";
import { defineHostExtension } from "../host-extensions.ts";
import type { Context } from "../../../packages/context/context.ts";
import { boxApplyEnvironment, type CapableBox } from "../../boxes/box-capabilities.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import {
  buildBoxSecretsEnv,
  validateBoxSecretsAtInterop,
} from "../../../adapters/interop/agent/box-secrets-adapter.ts";
import {
  BoxSecretsApplier,
  SECRETS_APPLY_WAIT_MS,
  SECRETS_RETRY_INITIAL_MS,
  SECRETS_RETRY_MAX_MS,
} from "./secrets-service.ts";

interface NamedRequestContextFactory {
  withName(name: string): Context;
}

interface SecretsExtensionHost {
  readonly log: (message: string) => void;
}

function createApplier(box: CapableBox, host: SecretsExtensionHost): BoxSecretsApplier {
  const retryPolicy = createRetryPolicy(realClock, {
    name: "slate-secrets-apply",
    maxAttempts: Number.MAX_SAFE_INTEGER,
    initialDelayMs: SECRETS_RETRY_INITIAL_MS,
    maxDelayMs: SECRETS_RETRY_MAX_MS,
  });
  const applyDeadline = createDeadlinePolicy(realClock, {
    name: "slate-secrets-save",
    timeoutMs: SECRETS_APPLY_WAIT_MS,
  });

  return new BoxSecretsApplier({
    applyToBox: (requestContext, update) => boxApplyEnvironment(box, requestContext, update),
    validateSecrets: validateBoxSecretsAtInterop,
    encodeEnvironment: buildBoxSecretsEnv,
    retryPolicy,
    applyDeadline,
    log: (message) => host.log(message),
  });
}

export function createSecretsExtension(createContext: () => NamedRequestContextFactory) {
  return defineHostExtension<unknown, SecretsExtensionHost>({
    id: HostExtensions.Secrets,
    dependencies: [HostExtensions.ForeverBox],
    start(context) {
      const requestContext = createContext().withName("secrets");
      const { box } = context.deps[HostExtensions.ForeverBox] as { box: CapableBox };
      const service = createApplier(box, context.host);

      context.onStop(() => service.stop());
      void service.applyPersisted(requestContext);

      return {
        set: ({ secrets }: { secrets: Record<string, string> }) => service.setSecrets(requestContext, secrets),
        getStatus: () => service.getStatus(),
      };
    },
  });
}

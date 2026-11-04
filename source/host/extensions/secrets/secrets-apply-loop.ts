import { BoxEnvironmentSyncUnsupportedError } from "../../ports/box.ts";
import { buildSlateBoxSecretsEnv } from "../../../shared/box-secret-policy.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { BoxSecretsApplierOptions } from "./secrets-service-contracts.ts";

/** Apply each desired generation, retrying ordinary failures until success or stop. */
export async function applyDesiredBoxSecretGenerations(args: {
  readonly context: Context;
  readonly options: BoxSecretsApplierOptions;
  readonly desired: () => Record<string, string>;
  readonly desiredGeneration: () => number;
  readonly appliedGeneration: () => number;
  readonly isStopped: () => boolean;
  readonly markApplied: (generation: number, atMs: number) => void;
  readonly stop: () => void;
  readonly notify: () => void;
  readonly log: (message: string) => void;
  readonly stopSignal: AbortSignal;
}): Promise<void> {
  let attempt = 0;
  while (args.appliedGeneration() < args.desiredGeneration() && !args.isStopped()) {
    const generation = args.desiredGeneration();
    try {
      const environment = (args.options.encodeEnvironment ?? buildSlateBoxSecretsEnv)(args.desired());
      await args.options.applyToBox(args.context, { env: environment, replace: true });
      args.markApplied(generation, (args.options.now ?? Date.now)());
      attempt = 0;
      args.notify();
    } catch (error) {
      if (error instanceof BoxEnvironmentSyncUnsupportedError) {
        args.stop();
        args.log("box secrets: this box has no environment sync; giving up");
        return;
      }

      attempt += 1;
      args.log(`box secrets: apply failed (attempt ${attempt}); retrying`);
      const retry = args.options.retryPolicy.schedule(attempt, args.stopSignal);
      try {
        await retry.elapsed;
      } catch (retryError) {
        if (args.isStopped()) return;
        throw retryError;
      } finally {
        retry.dispose();
      }
    }
  }
}

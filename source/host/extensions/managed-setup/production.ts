/**
 * The managed setup, built for the host that runs it.
 *
 * The extension's own context takes factories; this is where they come from. Everything here talks to the account's
 * dashboard through one client, built once per use over a credential that is read best-effort — a credential that
 * cannot be had is no credential rather than a failure — and the managed skills the platform fetches are kept under the
 * platform's own root.
 */

import { getSlateInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.ts";
import { createDashboardClient } from "../../../shared/node/marketplace/cursor-marketplace-client.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import type { HostExtensionContext } from "../host-extensions.ts";
import { fetchSkillCatalog, fetchSlateManagedSkills, type ManagedSkillsClient } from "./skills-marketplace.ts";
import type { ManagedSetupContext } from "./extension.ts";
import { getManagedSkillsDir } from "./managed-skills-cache.ts";
import { SlateManagedSkillsService } from "./managed-skills-service.ts";
import { createSlateTeamRulesResolver, type TeamRulesClient } from "./team-rules.ts";

/** The one dashboard client every part of the managed setup talks through. */
export type ManagedSetupDashboardClient = ManagedSkillsClient & TeamRulesClient;

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: ManagedSetupContext["deps"];
};

export function createManagedSetupProductionExtras(context: ProductionContext): Omit<ManagedSetupContext, "deps" | "onStop"> {
  const auth = context.deps.auth;
  /** The account's credential, or nothing: a token that could not be read is not a reason to fail a fetch. */
  const bestEffortToken = async (): Promise<string | null> => {
    try {
      const token = await auth.getAccessToken({ backendUrl: getSlateInferenceBackendUrl() });
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  };
  const createClient = (): ManagedSetupDashboardClient => createDashboardClient(bestEffortToken, async () => await auth.getMachineId()) as unknown as ManagedSetupDashboardClient;

  return {
    createManagedSkills({ report }) {
      return new SlateManagedSkillsService({
        // What the platform manages is kept where the platform keeps everything of its own.
        getCacheDir: () => getManagedSkillsDir(getSlateRootDir()),
        fetch: () => fetchSlateManagedSkills({ client: createClient() }),
        report,
      });
    },
    createTeamRules({ report }) {
      return createSlateTeamRulesResolver({ client: createClient(), report });
    },
    fetchSkillCatalog: async () => await fetchSkillCatalog(createClient(), (event) => context.deps.telemetry?.logs.reportHostExtensionDiagnostic(event)),
  };
}

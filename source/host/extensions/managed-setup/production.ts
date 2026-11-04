/**
 * The managed setup, built for the host that runs it.
 *
 * The extension's own context takes factories; this is where they come from. Everything here talks to the account's
 * dashboard through one client, built once per use over a credential that is read best-effort — a credential that
 * cannot be had is no credential rather than a failure — and the managed skills the platform fetches are kept under the
 * platform's own root.
 */

import { getSlateInferenceBackendUrl } from "../../../adapters/interop/cursor-backend/cursor-inference.ts";
import { createDashboardClient } from "../../../adapters/interop/plugin-marketplace/dashboard-client-adapter.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import type { HostExtensionContext } from "../host-extensions.ts";
import { fetchSkillCatalog, fetchSlateManagedSkills, type ManagedSkillsClient, type ManagedSkillsCatalogReport } from "./skills-marketplace.ts";
import type { ManagedSetupContext } from "./extension.ts";
import { getManagedSkillsDir } from "./managed-skills-cache.ts";
import { SlateManagedSkillsService } from "./managed-skills-service.ts";
import { createSlateTeamRulesResolver, type TeamRulesClient } from "./team-rules.ts";

/** The one dashboard client every part of the managed setup talks through. */
export type ManagedSetupDashboardClient = ManagedSkillsClient & TeamRulesClient;

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: ManagedSetupContext["deps"];
};

function dashboardClientFactory(context: ProductionContext): () => ManagedSetupDashboardClient {
  const auth = context.deps.auth;
  const optionalCredential = async (): Promise<string | null> => {
    try {
      const backendUrl = getSlateInferenceBackendUrl();
      const credential = await auth.getAccessToken({ backendUrl });
      return credential.length === 0 ? null : credential;
    } catch {
      return null;
    }
  };

  return () => createDashboardClient(
    optionalCredential,
    async () => await auth.getMachineId(),
  ) as unknown as ManagedSetupDashboardClient;
}

export function createManagedSetupProductionExtras(context: ProductionContext): Omit<ManagedSetupContext, "deps" | "onStop"> {
  const dashboard = dashboardClientFactory(context);
  const managedSkillsPath = () => getManagedSkillsDir(getSlateRootDir());
  const reportCatalogDiagnostic = (event: ManagedSkillsCatalogReport): void => {
    context.deps.telemetry?.logs.reportHostExtensionDiagnostic(event);
  };

  return {
    createManagedSkills({ report }) {
      return new SlateManagedSkillsService({
        getCacheDir: managedSkillsPath,
        fetch: () => fetchSlateManagedSkills({ client: dashboard() }),
        report,
      });
    },
    createTeamRules({ report }) {
      return createSlateTeamRulesResolver({ client: dashboard(), report });
    },
    fetchSkillCatalog: () => fetchSkillCatalog(dashboard(), reportCatalogDiagnostic),
  };
}

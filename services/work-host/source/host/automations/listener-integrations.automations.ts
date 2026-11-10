import { createListenerIntegrationsDashboard, SLATE_DASHBOARD_INTEGRATIONS_URL } from "../../adapters/interop/slate-backend/listener-integrations-dashboard.ts"
import { countListenerPlatforms, type ListenerPlatform } from "./listener-platforms.ts"

export { SLATE_DASHBOARD_INTEGRATIONS_URL } from "../../adapters/interop/slate-backend/listener-integrations-dashboard.ts"

export const LISTENER_PLATFORMS = [{ platform: "slack" as const }, { platform: "github" as const }]
export const CONNECTOR_MANIFESTS = [{ platform: "slack" as const }, { platform: "github" as const }]

export interface ListenerDashboardClient {
  getSlackUserSettings(): Promise<{ hasSlackAuth?: boolean }>
  getScmConnectionStatus(): Promise<{ connected?: boolean }>
  getSlackInstallUrl(): Promise<{ url: string }>
}

interface ListenerIntegrationDependencies {
  readonly auth?: {
    getAccessToken(args: { readonly backendUrl: string }): Promise<string>
    getMachineId(): Promise<string>
  }
  readonly dashboard?: () => ListenerDashboardClient
  readonly transcript: {
    listAllAutomationDefinitions(): Promise<readonly { automation: { isEnabled: boolean; trigger: Parameters<typeof countListenerPlatforms>[0][number]["trigger"] } }[]>
    getAgentChannels(agentId: string): Promise<readonly { platform: string; [key: string]: unknown }[]>
  }
  readonly sourceStatuses: () => ReadonlyMap<string, { state: string; detail?: string; scopeIssues?: readonly unknown[] }>
  readonly log?: (message: string) => void
}

export function createListenerIntegrationReads(deps: ListenerIntegrationDependencies) {
  const log = deps.log ?? ((message: string) => console.log(`[slate-listener-integrations] ${message}`))
  const dashboard = deps.dashboard ?? (() => {
    if (deps.auth === undefined) throw new TypeError("listener integrations require auth")
    return createListenerIntegrationsDashboard(deps.auth)
  })

  async function isPlatformConnected(platform: ListenerPlatform): Promise<boolean> {
    if (platform === "slack") return (await dashboard().getSlackUserSettings()).hasSlackAuth === true
    return (await dashboard().getScmConnectionStatus()).connected === true
  }

  async function getIntegrations() {
    const statuses = deps.sourceStatuses()
    const definitions = await deps.transcript.listAllAutomationDefinitions()
    const counts = countListenerPlatforms(definitions.map(({ automation }) => automation))
    const readStatus = (platform: ListenerPlatform) => isPlatformConnected(platform).catch(error => {
      const name = error instanceof Error ? error.name : typeof error
      log(`${platform} connection read degraded to disconnected: ${name}`)
      return false
    })
    const [slackConnected, githubConnected] = await Promise.all([readStatus("slack"), readStatus("github")])
    const connectionState = { slack: slackConnected, github: githubConnected }

    return {
      integrations: LISTENER_PLATFORMS.map(({ platform }) => {
        const status = statuses.get(platform)
        return {
          platform,
          isConnected: connectionState[platform],
          state: status?.state ?? "idle",
          ...(status?.detail == null ? {} : { detail: status.detail }),
          ...(status?.scopeIssues?.length ? { scopeIssues: status.scopeIssues } : {}),
          neededByCount: counts[platform],
        }
      }),
    }
  }

  async function getConnectUrl(platform: ListenerPlatform): Promise<string> {
    if (platform !== "slack") return SLATE_DASHBOARD_INTEGRATIONS_URL
    try {
      return (await dashboard().getSlackInstallUrl()).url || SLATE_DASHBOARD_INTEGRATIONS_URL
    } catch {
      return SLATE_DASHBOARD_INTEGRATIONS_URL
    }
  }

  async function getAgentChannels(agentId: string) {
    const supported = new Set(CONNECTOR_MANIFESTS.map(({ platform }) => platform))
    const connections = await deps.transcript.getAgentChannels(agentId)
    return {
      manifests: CONNECTOR_MANIFESTS,
      connections: connections.filter(connection => supported.has(connection.platform as ListenerPlatform)),
    }
  }

  return { isPlatformConnected, getIntegrations, getConnectUrl, getAgentChannels }
}

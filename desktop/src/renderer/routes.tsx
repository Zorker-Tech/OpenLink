import type { ComponentProps, ReactNode } from 'react'

import { AppWorkspace } from '@/components/app-workspace'
import { AuthPage } from '@/components/auth-page'
import { ChatWorkspace } from '@/components/chat-workspace'
import { KnowledgeWorkspace } from '@/components/knowledge-workspace'
import { OpenLinkHome } from '@/components/openlink-home'
import { ProjectSupabasePanel } from '@/components/project-supabase-panel'
import { ProjectsWorkspace } from '@/components/projects-workspace'
import { AiProvidersOverview } from '@/components/settings/ai-providers-overview'
import { CloudConnectionsSettings } from '@/components/settings/cloud-connections'
import { EmbeddingProviderConfigurationForm } from '@/components/settings/embedding-provider-configuration-form'
import { EmbeddingProvidersOverview } from '@/components/settings/embedding-providers-overview'
import { PreferencesForm } from '@/components/settings/preferences-form'
import { ProviderConfigurationForm } from '@/components/settings/provider-configuration-form'
import { ProviderNavigation } from '@/components/settings/provider-navigation'
import { SettingsShell } from '@/components/settings/settings-shell'
import { SkillsWorkspace } from '@/components/settings/skills-workspace'
import { OnboardingEntrance } from '@/app/app/onboarding/onboarding-entrance'
import { OnboardingForm } from '@/app/app/onboarding/onboarding-form'
import { useT } from '@/lib/i18n/client'

import { desktopBootstrap, type DesktopCapabilities } from './platform/api'
import type { DesktopRoute, DesktopRouteContext } from './router'

type Json = Record<string, unknown>

function props<T>(data: Json): T {
  return data as unknown as T
}

type SettingsShellProps = Omit<ComponentProps<typeof SettingsShell>, 'children'>

function SettingsPage({
  shell,
  children,
}: {
  shell: SettingsShellProps
  children: ReactNode
}) {
  return <SettingsShell {...shell}>{children}</SettingsShell>
}

function OnboardingPage({ data }: { data: Json }) {
  const t = useT()
  const payload = data as {
    prompt: string
    isCloud: boolean
    isCloudProjectStep: boolean
    isOrganizationStep: boolean
    defaultNickname: string
    cloudProjectSetup?: ComponentProps<typeof OnboardingForm>['cloudProjectSetup']
  }
  const step = payload.isCloudProjectStep
    ? 'project'
    : payload.isOrganizationStep
      ? 'organization'
      : 'nickname'

  return (
    <main className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center gap-3 px-6 sm:px-10">
        <span className="text-base font-semibold tracking-[-0.02em]">OpenLink</span>
        <span className="ml-auto text-xs font-medium text-muted-foreground sm:text-sm">
          {payload.isCloud ? t('Cloud 项目设置') : t('工作区设置')}
        </span>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-10 sm:px-8">
        <OnboardingEntrance className="w-full">
          <div className="mx-auto w-full max-w-[640px] rounded-[28px] border border-border bg-card p-6 shadow-[0_24px_80px_rgba(0,0,0,0.06)] sm:p-10">
            <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
              {payload.isCloud ? 'OpenLink · Cloud' : 'OpenLink · Workspace'}
            </p>
            <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-[-0.04em] sm:text-4xl">
              {payload.isCloudProjectStep
                ? t('选择 Studio 项目')
                : payload.isOrganizationStep
                  ? t('设置组织空间')
                  : t('设置个人空间')}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {payload.isCloudProjectStep
                ? t('选择一个已有项目关联到 OpenLink，或前往 Hydite Studio 创建组织/项目后返回刷新列表。')
                : payload.isOrganizationStep
                  ? t('创建组织、使用邀请码加入，或继续使用个人工作区。')
                  : t('确认你的昵称，并建立个人工作区。组织空间可以稍后添加。')}
            </p>
            <div className="mt-6 border-t border-border pt-6">
              <OnboardingForm
                cloudProjectSetup={payload.cloudProjectSetup}
                defaultNickname={payload.defaultNickname}
                prompt={payload.prompt}
                step={step}
              />
            </div>
          </div>
        </OnboardingEntrance>
      </div>
    </main>
  )
}

function navigateOnMount(path: string) {
  if (typeof window !== 'undefined') window.location.replace(path)
}

export function createDesktopRoutes(capabilities: DesktopCapabilities): DesktopRoute[] {
  const localRuntime = capabilities.runtimeMode === 'local'

  return [
    {
      pattern: '/',
      load: () => desktopBootstrap('home'),
      render: (data) => <OpenLinkHome {...props<ComponentProps<typeof OpenLinkHome>>(data)} />,
    },
    {
      pattern: '/login',
      render: () => <AuthPage localRuntime={localRuntime} mode="login" />,
    },
    {
      pattern: '/register',
      render: () => <AuthPage localRuntime={localRuntime} mode="register" />,
    },
    {
      pattern: '/app',
      load: () => desktopBootstrap('app-entry'),
      render: () => null,
    },
    {
      pattern: '/app/onboarding',
      load: ({ search }) => desktopBootstrap('onboarding', search),
      render: (data) => <OnboardingPage data={data} />,
    },
    {
      pattern: '/app/:workspaceName/projects',
      load: ({ params }) =>
        desktopBootstrap(`workspace/${encodeURIComponent(params.workspaceName)}/projects`),
      render: (data) => <ProjectsWorkspace {...props<ComponentProps<typeof ProjectsWorkspace>>(data)} />,
    },
    {
      pattern: '/app/:workspaceName/knowledge/*',
      load: ({ params }) =>
        desktopBootstrap(
          `workspace/${encodeURIComponent(params.workspaceName)}/knowledge`,
          new URLSearchParams({ path: params['*'] ?? '' }),
        ),
      render: (data) => <KnowledgeWorkspace {...props<ComponentProps<typeof KnowledgeWorkspace>>(data)} />,
    },
    {
      pattern: '/app/:workspaceName',
      load: ({ params, search }) =>
        desktopBootstrap(`workspace/${encodeURIComponent(params.workspaceName)}`, search),
      render: (data) => <AppWorkspace {...props<ComponentProps<typeof AppWorkspace>>(data)} />,
    },
    {
      pattern: '/:userId/chat/:sessionId/data',
      load: ({ params }) =>
        desktopBootstrap(`chat/${encodeURIComponent(params.userId)}/${encodeURIComponent(params.sessionId)}/data`),
      render: (data) => (
        <ProjectSupabasePanel {...props<ComponentProps<typeof ProjectSupabasePanel>>(data)} />
      ),
    },
    {
      pattern: '/:userId/chat/:sessionId',
      load: ({ params, search }) =>
        desktopBootstrap(
          `chat/${encodeURIComponent(params.userId)}/${encodeURIComponent(params.sessionId)}`,
          search,
        ),
      render: (data) => <ChatWorkspace {...props<ComponentProps<typeof ChatWorkspace>>(data)} />,
    },
    {
      pattern: '/settings',
      load: () => desktopBootstrap('settings'),
      render: (data) => {
        const payload = data as { shell: SettingsShellProps; page: { preferences: ComponentProps<typeof PreferencesForm>['initial'] } }
        return (
          <SettingsPage shell={payload.shell}>
            <div className="size-full overflow-y-auto px-6 py-12 sm:px-10 lg:px-16">
              <PreferencesForm initial={payload.page.preferences} />
              {capabilities.runtimeMode === 'cloud' && (
                <CloudConnectionsSettings
                  locale={payload.shell.preferences.locale}
                  loginEnabled={false}
                />
              )}
            </div>
          </SettingsPage>
        )
      },
    },
    {
      pattern: '/settings/ai-providers',
      load: () => desktopBootstrap('settings/providers'),
      render: (data) => {
        const payload = data as {
          shell: SettingsShellProps
          page: {
            configurations: ComponentProps<typeof ProviderNavigation>['configurations']
            embeddingConfigurations: ComponentProps<typeof ProviderNavigation>['embeddingConfigurations']
          }
        }
        return (
          <SettingsPage shell={payload.shell}>
            <div className="flex size-full min-w-0">
              <ProviderNavigation
                configurations={payload.page.configurations}
                embeddingConfigurations={payload.page.embeddingConfigurations}
              />
              <AiProvidersOverview configurations={payload.page.configurations} />
            </div>
          </SettingsPage>
        )
      },
    },
    {
      pattern: '/settings/ai-providers/embeddings',
      load: () => desktopBootstrap('settings/embeddings'),
      render: (data) => {
        const payload = data as {
          shell: SettingsShellProps
          page: {
            configurations: ComponentProps<typeof ProviderNavigation>['configurations']
            embeddingConfigurations: ComponentProps<typeof ProviderNavigation>['embeddingConfigurations']
          }
        }
        return (
          <SettingsPage shell={payload.shell}>
            <div className="flex size-full min-w-0">
              <ProviderNavigation
                configurations={payload.page.configurations}
                embeddingConfigurations={payload.page.embeddingConfigurations}
                mode="embedding"
              />
              <EmbeddingProvidersOverview configurations={payload.page.embeddingConfigurations ?? []} />
            </div>
          </SettingsPage>
        )
      },
    },
    {
      pattern: '/settings/ai-providers/embeddings/:providerId',
      load: ({ params }) =>
        desktopBootstrap(`settings/embeddings/${encodeURIComponent(params.providerId)}`),
      render: (data) => {
        const payload = data as {
          shell: SettingsShellProps
          page: {
            configuration: ComponentProps<typeof EmbeddingProviderConfigurationForm>['configuration']
            configurations: ComponentProps<typeof ProviderNavigation>['configurations']
            embeddingConfigurations: ComponentProps<typeof ProviderNavigation>['embeddingConfigurations']
            provider: ComponentProps<typeof EmbeddingProviderConfigurationForm>['provider']
          }
        }
        return (
          <SettingsPage shell={payload.shell}>
            <div className="flex size-full min-w-0">
              <div className="hidden h-full sm:block">
                <ProviderNavigation
                  configurations={payload.page.configurations}
                  currentProviderId={payload.page.provider.id}
                  embeddingConfigurations={payload.page.embeddingConfigurations}
                  mode="embedding"
                />
              </div>
              <EmbeddingProviderConfigurationForm
                configuration={payload.page.configuration}
                provider={payload.page.provider}
              />
            </div>
          </SettingsPage>
        )
      },
    },
    {
      pattern: '/settings/ai-providers/:providerId',
      load: ({ params }) =>
        desktopBootstrap(`settings/providers/${encodeURIComponent(params.providerId)}`),
      render: (data) => {
        const payload = data as {
          shell: SettingsShellProps
          page: {
            configuration: ComponentProps<typeof ProviderConfigurationForm>['configuration']
            configurations: ComponentProps<typeof ProviderNavigation>['configurations']
            embeddingConfigurations: ComponentProps<typeof ProviderNavigation>['embeddingConfigurations']
            models: ComponentProps<typeof ProviderConfigurationForm>['models']
            provider: ComponentProps<typeof ProviderConfigurationForm>['provider']
          }
        }
        return (
          <SettingsPage shell={payload.shell}>
            <div className="flex size-full min-w-0">
              <div className="hidden h-full sm:block">
                <ProviderNavigation
                  configurations={payload.page.configurations}
                  currentProviderId={payload.page.provider.id}
                  embeddingConfigurations={payload.page.embeddingConfigurations}
                />
              </div>
              <ProviderConfigurationForm
                configuration={payload.page.configuration}
                models={payload.page.models}
                provider={payload.page.provider}
              />
            </div>
          </SettingsPage>
        )
      },
    },
    {
      pattern: '/settings/skills',
      load: () => desktopBootstrap('settings/skills'),
      render: (data) => {
        const payload = data as {
          shell: SettingsShellProps
          page: ComponentProps<typeof SkillsWorkspace>
        }
        return (
          <SettingsPage shell={payload.shell}>
            <SkillsWorkspace {...payload.page} />
          </SettingsPage>
        )
      },
    },
    {
      pattern: '/settings/skills/:skillId',
      load: ({ params }) =>
        desktopBootstrap(`settings/skills/${encodeURIComponent(params.skillId)}`),
      render: (data) => {
        const payload = data as {
          shell: SettingsShellProps
          page: ComponentProps<typeof SkillsWorkspace>
        }
        return (
          <SettingsPage shell={payload.shell}>
            <SkillsWorkspace {...payload.page} />
          </SettingsPage>
        )
      },
    },
    {
      pattern: '*',
      render: () => <DesktopNotFound />,
    },
  ]
}

function DesktopNotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">This page is not available.</p>
        <a className="mt-6 inline-flex text-sm font-medium underline" href="/">
          Home
        </a>
      </div>
    </main>
  )
}

// Kept for callers that need to force a full navigation from a route loader.
export { navigateOnMount }
export type { DesktopRouteContext }

import { Check } from 'lucide-react'
import { OnboardingEntrance } from './onboarding-entrance'
import { OnboardingForm } from './onboarding-form'
import { ZorkerLogo } from '@/components/zorker-logo'
import { getT } from '@/lib/i18n/server'
import { getDefaultNickname } from '@/lib/workspaces'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { getCloudConnection, listCloudConnections } from '@/lib/platform-cloud-connection.server'
import type { CloudProjectConnectionState, CloudProjectOption } from '@/lib/platform-cloud-project'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

async function loadCloudProjectSetup(): Promise<{
  connectionId: string | null
  connectionState: CloudProjectConnectionState
  projects: CloudProjectOption[]
}> {
  try {
    const connections = await listCloudConnections()
    const connection = connections.find((item) =>
      ['active', 'refreshing', 'reauth_required'].includes(item.state),
    )
    if (!connection) return { connectionId: null, connectionState: 'disconnected', projects: [] }
    if (connection.state === 'reauth_required') {
      return { connectionId: connection.id, connectionState: 'reauth_required', projects: [] }
    }

    const current = await getCloudConnection(connection.id)
    if (!['active', 'refreshing'].includes(current.state)) {
      return { connectionId: connection.id, connectionState: 'reauth_required', projects: [] }
    }
    const projects = await current.sdk.listProjects()
    return {
      connectionId: connection.id,
      connectionState: 'active',
      projects: projects.map(({ id, name, organizationId }) => ({ id, name, organizationId })),
    }
  } catch {
    return { connectionId: null, connectionState: 'load_error', projects: [] }
  }
}

export async function generateMetadata() {
  const { t } = await getT()
  return {
    title: getRuntimeMode() === 'cloud' ? t('选择项目 — OpenLink') : t('设置工作区 — OpenLink'),
  }
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string; step?: string }>
}) {
  const { prompt = '', step: requestedStep } = await searchParams
  const { t } = await getT()
  const isCloud = getRuntimeMode() === 'cloud'
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect(`/login?next=${encodeURIComponent('/app/onboarding')}`)

  const { data: profile } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('nickname, nickname_confirmed, organization_onboarding_completed')
    .eq('user_id', user.id)
    .maybeSingle()

  const typedProfile = profile as {
    nickname?: string
    nickname_confirmed?: boolean
    organization_onboarding_completed?: boolean
  } | null
  const isCloudProjectStep = isCloud && Boolean(typedProfile?.nickname_confirmed)
  const isOrganizationStep = !isCloud && (requestedStep === 'organization' || Boolean(typedProfile?.nickname_confirmed))
  const isSecondStep = isCloud ? isCloudProjectStep : isOrganizationStep
  const cloudProjectLayout = isCloudProjectStep

  if (isSecondStep && !isCloudProjectStep && typedProfile?.organization_onboarding_completed) redirect('/app')

  const cloudProjectSetup = isCloudProjectStep ? await loadCloudProjectSetup() : undefined

  const steps = [
    {
      index: '01',
      title: isCloud ? t('账号资料') : t('个人空间'),
      description: isCloud ? t('确认 OpenLink 个人资料') : t('建立你的个人工作区'),
      complete: isSecondStep,
      active: !isSecondStep,
    },
    {
      index: '02',
      title: isCloud ? t('Studio 项目') : t('组织空间'),
      description: isCloud ? t('选择一个可访问的项目') : t('按需创建或加入'),
      complete: false,
      active: isSecondStep,
    },
  ]

  return (
    <main className={`flex ${cloudProjectLayout ? 'h-dvh min-h-0 overflow-hidden' : 'min-h-dvh'} flex-col bg-background text-foreground`}>
      <header className="flex h-14 shrink-0 items-center justify-between px-4 sm:h-16 sm:px-8 lg:h-[72px] lg:px-10">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full border border-border bg-card shadow-sm">
            <ZorkerLogo className="h-5 w-[34px]" />
          </div>
          <span className="text-base font-semibold tracking-[-0.02em]">OpenLink</span>
        </div>
        <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground sm:text-sm">
          <span aria-hidden="true" className="size-2 rounded-full bg-foreground/60" />
          <span>{isCloud ? t('Cloud 项目设置') : t('工作区设置')}</span>
          <span aria-hidden="true" className="text-border">/</span>
          <span className="tabular-nums">{isSecondStep ? '02' : '01'} / 02</span>
        </div>
      </header>

      <div className={`flex flex-1 ${cloudProjectLayout ? 'min-h-0 overflow-hidden py-2' : 'pb-8 pt-2 sm:pb-10'} items-center justify-center px-3 sm:px-6 lg:px-10`}>
        <OnboardingEntrance className={`${cloudProjectLayout ? 'h-full min-h-0' : ''} w-full`}>
          <div
            className={`mx-auto grid ${cloudProjectLayout ? 'h-full min-h-0 grid-rows-[minmax(0,1fr)]' : ''} w-full max-w-[1400px] overflow-hidden rounded-[28px] border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.06)] lg:grid-cols-[44%_56%]`}
            style={!cloudProjectLayout ? { minHeight: 'min(890px, calc(100dvh - 152px))' } : undefined}
          >
            <aside className={`${isCloudProjectStep ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col justify-between border-b border-border bg-muted/25 px-5 py-[clamp(1rem,4vh,2.5rem)] sm:px-8 lg:border-b-0 lg:border-r lg:px-10 xl:px-14`}>
              <div className="max-w-[500px]">
                <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
                  {isCloud ? 'OpenLink · Cloud / VTSLX' : 'OpenLink · Workspace'}
                </p>
                <h2 className="mt-[clamp(1rem,3vh,1.5rem)] max-w-[460px] text-3xl font-semibold leading-[1.08] tracking-[-0.045em] text-balance sm:text-4xl lg:text-[clamp(2.5rem,6vh,3.25rem)]">
                  {t(isCloud ? '从 Studio 项目开始你的 Cloud 工作流。' : '从一个清晰、专注的空间开始。')}
                </h2>
                <p className="mt-[clamp(0.75rem,2.5vh,1.25rem)] max-w-[420px] text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                  {t(isCloud
                    ? '连接 VTSLX 后，选择 Hydite Studio 中你有权限使用的项目。'
                    : '先完成个人空间设置。组织是可选的，你可以之后再添加。')}
                </p>

                <ol aria-label={t(isCloud ? 'Cloud 项目设置步骤' : '工作区设置步骤')} className="mt-[clamp(1rem,4vh,2.5rem)] space-y-2 sm:space-y-3 lg:mt-[clamp(1.25rem,6vh,3.5rem)]">
                  {steps.map((item) => (
                    <li
                      className={`flex min-h-[64px] items-center gap-3 rounded-2xl border px-3 py-2 transition-colors sm:gap-4 sm:px-4 ${item.active
                        ? 'border-border bg-card shadow-[0_2px_7px_rgba(0,0,0,0.08)]'
                        : item.complete
                          ? 'border-transparent bg-transparent'
                          : 'border-transparent bg-transparent opacity-70'}`}
                      key={item.index}
                    >
                      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full border text-sm font-medium ${item.complete
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border bg-card text-muted-foreground'}`}>
                        {item.complete ? <Check aria-hidden="true" className="size-4" strokeWidth={2.5} /> : item.index}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foreground">{item.title}</span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground sm:text-sm">{item.description}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <p className="mt-6 max-w-[420px] text-xs leading-5 text-muted-foreground sm:text-sm sm:leading-6">
                {t(isCloud
                  ? '组织和项目由 Hydite Studio 管理；OpenLink 会保存所选项目的授权关联。'
                  : '个人与组织空间彼此独立。你可以稍后在设置中管理工作区。')}
              </p>
            </aside>

            <section className={`flex items-center justify-center px-4 py-[clamp(1rem,4vh,2.5rem)] sm:px-8 lg:px-10 xl:px-14 ${cloudProjectLayout ? 'min-h-0 overflow-hidden' : ''}`}>
              <div className={`w-full max-w-[640px] ${cloudProjectLayout ? 'max-h-full overflow-hidden' : ''}`}>
                <h1 className="mt-0 text-3xl font-semibold leading-tight tracking-[-0.04em] sm:text-4xl lg:text-[clamp(2.25rem,5.5vh,3rem)]">
                  {isCloudProjectStep
                    ? t('选择 Studio 项目')
                    : isOrganizationStep
                      ? t('设置组织空间')
                      : t('设置个人空间')}
                </h1>
                <p className="mt-2 max-w-[600px] text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                  {isCloudProjectStep
                    ? t('选择一个已有项目关联到 OpenLink，或前往 Hydite Studio 创建组织/项目后返回刷新列表。')
                    : isOrganizationStep
                      ? t('创建组织、使用邀请码加入，或继续使用个人工作区。')
                      : isCloud
                        ? t('确认你的昵称，用于 OpenLink 中的个人显示；下一步将从 Studio 选择项目。')
                        : t('确认你的昵称，并建立个人工作区。组织空间可以稍后添加。')}
                </p>

                <div className="mt-5 border-t border-border pt-5 sm:mt-6 sm:pt-6">
                  <OnboardingForm
                    defaultNickname={typedProfile?.nickname ?? getDefaultNickname(user)}
                    prompt={prompt}
                    step={isCloudProjectStep ? 'project' : isOrganizationStep ? 'organization' : 'nickname'}
                    cloudProjectSetup={cloudProjectSetup}
                  />
                </div>
              </div>
            </section>
          </div>
        </OnboardingEntrance>
      </div>
    </main>
  )
}

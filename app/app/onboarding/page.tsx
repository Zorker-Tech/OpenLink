import { OnboardingForm } from './onboarding-form'
import { ZorkerLogo } from '@/components/zorker-logo'
import { getT } from '@/lib/i18n/server'
import { getDefaultNickname } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export async function generateMetadata() {
  const { t } = await getT()
  return { title: t('设置工作区 — OpenLink') }
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string; step?: string }>
}) {
  const { prompt = '', step: requestedStep } = await searchParams
  const { t } = await getT()
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
  const step = requestedStep === 'organization' || typedProfile?.nickname_confirmed
    ? 'organization'
    : 'nickname'

  if (step === 'organization' && typedProfile?.organization_onboarding_completed) redirect('/app')

  const isOrganizationStep = step === 'organization'
  const steps = [
    {
      index: '01',
      title: t('个人身份'),
      description: t('确认昵称并创建个人工作区'),
      active: !isOrganizationStep,
      complete: isOrganizationStep,
    },
    {
      index: '02',
      title: t('组织空间'),
      description: t('创建、加入或暂时跳过组织'),
      active: isOrganizationStep,
      complete: false,
    },
  ]

  return (
    <main
      className="min-h-dvh bg-background text-foreground"
      style={{ minWidth: 800 }}
    >
      <header className="flex h-16 items-center justify-between border-b border-border px-5 sm:px-8 lg:px-10">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full border border-border bg-card">
            <ZorkerLogo className="h-5 w-[34px]" />
          </div>
          <span className="text-sm font-semibold tracking-[-0.01em]">OpenLink</span>
        </div>
        <span className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Workspace setup</span>
      </header>

      <div
        className="grid"
        style={{
          minHeight: 'calc(100dvh - 4rem)',
          gridTemplateColumns: 'clamp(280px, 34vw, 560px) minmax(480px, 1fr)',
        }}
      >
        <aside className="flex flex-col justify-between bg-muted/25 px-6 py-10 sm:px-10 lg:px-12 lg:py-14 xl:px-16">
          <div className="max-w-md">
            <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">Get started</p>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.045em] text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]">
              {t('为你的工作建立一个清晰起点。')}
            </h2>
            <p className="mt-5 max-w-sm text-sm leading-6 text-muted-foreground sm:text-[15px]">
              {t('先创建个人工作区，再按需连接组织。你的个人设置与组织权限始终保持独立。')}
            </p>

            <ol className="mt-10 space-y-3 lg:mt-14">
              {steps.map((item) => (
                <li
                  className={`flex items-start gap-4 border-l-2 py-2 pl-4 transition-colors ${item.active ? 'border-foreground' : 'border-border'}`}
                  key={item.index}
                >
                  <span className={`pt-0.5 font-mono text-xs ${item.active ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {item.complete ? '✓' : item.index}
                  </span>
                  <div>
                    <p className={`text-sm font-medium ${item.active ? 'text-foreground' : 'text-muted-foreground'}`}>{item.title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <p className="mt-12 hidden max-w-sm text-xs leading-5 text-muted-foreground lg:block">
            {t('工作区用于隔离项目、对话、知识与运行资源。之后可以随时在设置中调整。')}
          </p>
        </aside>

        <section className="flex items-center justify-center px-6 py-12 sm:px-10 lg:px-16 lg:py-16 xl:px-24">
          <div className="w-full max-w-[520px]">
            <p className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              Step {isOrganizationStep ? '02' : '01'} / 02
            </p>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              {isOrganizationStep ? t('设置组织工作区') : t('创建你的昵称')}
            </h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground sm:text-[15px]">
              {isOrganizationStep
                ? t('组织是可选的。你可以创建新组织、使用邀请码加入，也可以继续使用个人工作区。')
                : t('昵称将成为默认个人工作区名称，并显示在你的 OpenLink 工作空间中。')}
            </p>

            <div className="mt-9 border-t border-border pt-8">
              <OnboardingForm
                defaultNickname={typedProfile?.nickname ?? getDefaultNickname(user)}
                prompt={prompt}
                step={step}
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

import { Check } from 'lucide-react'
import { OnboardingEntrance } from './onboarding-entrance'
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
  const isOrganizationStep = requestedStep === 'organization' || Boolean(typedProfile?.nickname_confirmed)

  if (isOrganizationStep && typedProfile?.organization_onboarding_completed) redirect('/app')

  const steps = [
    {
      index: '01',
      title: t('个人空间'),
      description: t('建立你的个人工作区'),
      complete: isOrganizationStep,
      active: !isOrganizationStep,
    },
    {
      index: '02',
      title: t('组织空间'),
      description: t('按需创建或加入'),
      complete: false,
      active: isOrganizationStep,
    },
  ]

  return (
    <main className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex h-[72px] shrink-0 items-center justify-between px-5 sm:px-8 lg:px-10">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full border border-border bg-card shadow-sm">
            <ZorkerLogo className="h-5 w-[34px]" />
          </div>
          <span className="text-base font-semibold tracking-[-0.02em]">OpenLink</span>
        </div>
        <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground sm:text-sm">
          <span aria-hidden="true" className="size-2 rounded-full bg-foreground/60" />
          <span>{t('工作区设置')}</span>
          <span aria-hidden="true" className="text-border">/</span>
          <span className="tabular-nums">{isOrganizationStep ? '02' : '01'} / 02</span>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 pb-8 pt-2 sm:px-7 sm:pb-10 lg:px-10">
        <OnboardingEntrance className="w-full">
          <div
            className="mx-auto grid w-full max-w-[1400px] overflow-hidden rounded-[28px] border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.06)] lg:grid-cols-[44%_56%]"
            style={{ minHeight: 'min(890px, calc(100dvh - 152px))' }}
          >
            <aside className="flex flex-col justify-between border-b border-border bg-muted/25 px-6 py-8 sm:px-10 sm:py-12 lg:border-b-0 lg:border-r lg:px-12 lg:py-14 xl:px-16">
              <div className="max-w-[500px]">
                <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
                  OpenLink · Workspace
                </p>
                <h2 className="mt-6 max-w-[460px] text-3xl font-semibold leading-[1.08] tracking-[-0.045em] text-balance sm:text-4xl lg:text-[3.25rem]">
                  {t('从一个清晰、专注的空间开始。')}
                </h2>
                <p className="mt-5 max-w-[420px] text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                  {t('先完成个人空间设置。组织是可选的，你可以之后再添加。')}
                </p>

                <ol aria-label={t('工作区设置步骤')} className="mt-9 space-y-3 sm:mt-12 lg:mt-16">
                  {steps.map((item) => (
                    <li
                      className={`flex min-h-[78px] items-center gap-4 rounded-2xl border px-4 py-3 transition-colors ${item.active
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

              <p className="mt-10 max-w-[420px] text-xs leading-5 text-muted-foreground sm:text-sm sm:leading-6">
                {t('个人与组织空间彼此独立。你可以稍后在设置中管理工作区。')}
              </p>
            </aside>

            <section className="flex items-center justify-center px-6 py-10 sm:px-10 sm:py-12 lg:px-12 lg:py-16 xl:px-16">
              <div className="w-full max-w-[640px]">
                <div className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-muted/30 px-4 text-xs font-medium text-muted-foreground sm:text-sm">
                  <span aria-hidden="true" className="size-2 rounded-full bg-foreground/60" />
                  {t(isOrganizationStep ? '第 2 步，共 2 步' : '第 1 步，共 2 步')}
                </div>
                <h1 className="mt-6 text-3xl font-semibold leading-tight tracking-[-0.04em] sm:text-4xl lg:text-[3rem]">
                  {isOrganizationStep ? t('设置组织空间') : t('设置个人空间')}
                </h1>
                <p className="mt-3 max-w-[600px] text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                  {isOrganizationStep
                    ? t('创建组织、使用邀请码加入，或继续使用个人工作区。')
                    : t('确认你的昵称，并建立个人工作区。组织空间可以稍后添加。')}
                </p>

                <div className="mt-8 border-t border-border pt-7 sm:mt-10 sm:pt-9">
                  <OnboardingForm
                    defaultNickname={typedProfile?.nickname ?? getDefaultNickname(user)}
                    prompt={prompt}
                    step={isOrganizationStep ? 'organization' : 'nickname'}
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

import { OnboardingForm } from './onboarding-form'
import { getDefaultNickname } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export const metadata = {
  title: '设置工作区 — OpenLink',
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string; step?: string }>
}) {
  const { prompt = '', step: requestedStep } = await searchParams
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

  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-6 text-[#ededed]">
      <section className="w-full max-w-[400px] rounded-2xl border border-[#27272a] bg-[#121212] p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full border border-white/14 bg-black">
            <img alt="OpenLink" className="h-4 w-8" src="/openlink/logo-wide.svg" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.4px]">{step === 'nickname' ? '创建你的昵称' : '设置组织工作区'}</h1>
            <p className="mt-1 text-sm text-[#a0a0a0]">
              {step === 'nickname' ? '昵称将成为默认个人工作区名称。' : '组织是可选的，你也可以继续使用个人工作区。'}
            </p>
          </div>
        </div>
        <OnboardingForm
          defaultNickname={typedProfile?.nickname ?? getDefaultNickname(user)}
          prompt={prompt}
          step={step}
        />
      </section>
    </main>
  )
}

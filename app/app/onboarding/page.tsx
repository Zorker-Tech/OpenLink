import { OnboardingForm } from './onboarding-form'
import { getDefaultNickname } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export const metadata = {
  title: '创建昵称 — OpenLink',
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>
}) {
  const { prompt = '' } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect(`/login?next=${encodeURIComponent('/app/onboarding')}`)

  const { data: profile } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('nickname')
    .eq('user_id', user.id)
    .maybeSingle()

  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-6 text-[#ededed]">
      <section className="w-full max-w-[400px] rounded-2xl border border-[#27272a] bg-[#121212] p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full border border-white/14 bg-black">
            <img alt="OpenLink" className="h-4 w-8" src="/openlink/logo-wide.svg" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.4px]">创建你的昵称</h1>
            <p className="mt-1 text-sm text-[#a0a0a0]">昵称将成为默认工作区名称。</p>
          </div>
        </div>
        <OnboardingForm
          defaultNickname={(profile as { nickname?: string } | null)?.nickname ?? getDefaultNickname(user)}
          prompt={prompt}
        />
      </section>
    </main>
  )
}

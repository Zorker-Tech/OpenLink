import { resolveAppEntry } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

function withPrompt(path: string, prompt?: string) {
  return prompt ? `${path}?prompt=${encodeURIComponent(prompt)}` : path
}

export default async function AppEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>
}) {
  const { prompt } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(withPrompt('/app', prompt))}`)
  }

  const entry = await resolveAppEntry(supabase, user)

  if (entry.needsOnboarding) {
    redirect(withPrompt('/app/onboarding', prompt))
  }

  redirect(withPrompt(`/app/${entry.workspace.slug}`, prompt))
}

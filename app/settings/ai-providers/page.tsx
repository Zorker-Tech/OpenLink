import { AiProvidersOverview } from '@/components/settings/ai-providers-overview'
import { ProviderNavigation } from '@/components/settings/provider-navigation'
import { listAiProviderConfigurations } from '@/lib/ai-provider-configurations.server'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function AiProvidersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings/ai-providers')
  const configurations = await listAiProviderConfigurations(supabase, user.id)
  return <div className="flex size-full min-w-0"><ProviderNavigation configurations={configurations} /><AiProvidersOverview configurations={configurations} /></div>
}

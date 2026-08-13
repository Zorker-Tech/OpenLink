import { AiProvidersOverview } from '@/components/settings/ai-providers-overview'
import { ProviderNavigation } from '@/components/settings/provider-navigation'
import { listAiProviderConfigurations } from '@/lib/ai-provider-configurations.server'
import { listEmbeddingProviderConfigurations } from '@/lib/embedding-provider-configurations.server'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function AiProvidersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings/ai-providers')
  const [configurations, embeddingConfigurations] = await Promise.all([listAiProviderConfigurations(supabase, user.id), listEmbeddingProviderConfigurations(supabase, user.id)])
  return <div className="flex size-full min-w-0"><ProviderNavigation configurations={configurations} embeddingConfigurations={embeddingConfigurations} /><AiProvidersOverview configurations={configurations} /></div>
}

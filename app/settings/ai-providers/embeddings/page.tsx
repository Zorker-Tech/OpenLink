import { EmbeddingProvidersOverview } from '@/components/settings/embedding-providers-overview'
import { ProviderNavigation } from '@/components/settings/provider-navigation'
import { listAiProviderConfigurations } from '@/lib/ai-provider-configurations.server'
import { listEmbeddingProviderConfigurations } from '@/lib/embedding-provider-configurations.server'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function EmbeddingProvidersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings/ai-providers/embeddings')
  const [configurations, embeddingConfigurations] = await Promise.all([listAiProviderConfigurations(supabase, user.id), listEmbeddingProviderConfigurations(supabase, user.id)])
  return <div className="flex size-full min-w-0"><ProviderNavigation configurations={configurations} embeddingConfigurations={embeddingConfigurations} mode="embedding" /><EmbeddingProvidersOverview configurations={embeddingConfigurations} /></div>
}

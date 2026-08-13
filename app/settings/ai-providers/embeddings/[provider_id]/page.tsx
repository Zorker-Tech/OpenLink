import { EmbeddingProviderConfigurationForm } from '@/components/settings/embedding-provider-configuration-form'
import { ProviderNavigation } from '@/components/settings/provider-navigation'
import { listAiProviderConfigurations } from '@/lib/ai-provider-configurations.server'
import { getEmbeddingProviderConfiguration, listEmbeddingProviderConfigurations } from '@/lib/embedding-provider-configurations.server'
import { getEmbeddingProvider } from '@/lib/embedding-providers'
import { createClient } from '@/utils/supabase/server'
import { notFound, redirect } from 'next/navigation'

export default async function EmbeddingProviderDetailPage({ params }: { params: Promise<{ provider_id: string }> }) {
  const { provider_id: providerId } = await params
  const provider = getEmbeddingProvider(providerId)
  if (!provider) notFound()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/settings/ai-providers/embeddings/${providerId}`)}`)
  const [configuration, configurations, embeddingConfigurations] = await Promise.all([
    getEmbeddingProviderConfiguration(supabase, user.id, providerId),
    listAiProviderConfigurations(supabase, user.id),
    listEmbeddingProviderConfigurations(supabase, user.id),
  ])
  return <div className="flex size-full min-w-0"><div className="hidden h-full sm:block"><ProviderNavigation configurations={configurations} currentProviderId={providerId} embeddingConfigurations={embeddingConfigurations} mode="embedding" /></div><EmbeddingProviderConfigurationForm configuration={configuration} provider={provider} /></div>
}

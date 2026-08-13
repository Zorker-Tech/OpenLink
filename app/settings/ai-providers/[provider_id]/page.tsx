import { ProviderConfigurationForm } from '@/components/settings/provider-configuration-form'
import { ProviderNavigation } from '@/components/settings/provider-navigation'
import { getAiProviderConfiguration, listAiProviderConfigurations } from '@/lib/ai-provider-configurations.server'
import { getAiProviderModels } from '@/lib/ai-provider-models.server'
import { getAiProvider } from '@/lib/ai-providers'
import { listEmbeddingProviderConfigurations } from '@/lib/embedding-provider-configurations.server'
import { createClient } from '@/utils/supabase/server'
import { notFound, redirect } from 'next/navigation'

export default async function ProviderDetailPage({ params }: { params: Promise<{ provider_id: string }> }) {
  const { provider_id: providerId } = await params
  const provider = getAiProvider(providerId)
  if (!provider) notFound()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/settings/ai-providers/${providerId}`)}`)
  const [configuration, configurations, embeddingConfigurations, models] = await Promise.all([
    getAiProviderConfiguration(supabase, user.id, providerId),
    listAiProviderConfigurations(supabase, user.id),
    listEmbeddingProviderConfigurations(supabase, user.id),
    getAiProviderModels(providerId),
  ])
  return <div className="flex size-full min-w-0"><div className="hidden h-full sm:block"><ProviderNavigation configurations={configurations} currentProviderId={providerId} embeddingConfigurations={embeddingConfigurations} /></div><ProviderConfigurationForm configuration={configuration} models={models} provider={provider} /></div>
}

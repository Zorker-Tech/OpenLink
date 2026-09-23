'use client'

import { ProviderCard } from '@/components/settings/provider-card'
import type { AiProviderConfigurationSummary } from '@/lib/ai-provider-types'
import { AI_PROVIDERS } from '@/lib/ai-providers'
import { useT } from '@/lib/i18n/client'

export function AiProvidersOverview({ configurations }: { configurations: AiProviderConfigurationSummary[] }) {
  const t = useT()
  const configurationMap = new Map(configurations.map((item) => [item.providerId, item]))
  const enabled = AI_PROVIDERS.filter((item) => configurationMap.get(item.id)?.enabled)
  const disabled = AI_PROVIDERS.filter((item) => !configurationMap.get(item.id)?.enabled)

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-[1024px] pb-12">
        <header>
          <h1 className="text-[24px] font-semibold tracking-[-0.55px]">{t('AI 服务商')}</h1>
          <p className="mt-1 max-w-[720px] text-sm leading-[22px] text-[var(--app-muted)]">
            {t('配置 Pi Agent 使用的模型服务商。密钥经 AES-256-GCM 加密，并在隔离运行时中通过 Credential Vault 注入。')}
          </p>
        </header>

        {enabled.length > 0 && <ProviderGrid configurations={configurationMap} label={t('已启用服务商')} providers={enabled} />}
        <ProviderGrid configurations={configurationMap} label={t('未启用服务商')} providers={disabled} />
      </div>
    </main>
  )
}

function ProviderGrid({ configurations, label, providers }: {
  configurations: Map<string, AiProviderConfigurationSummary>
  label: string
  providers: readonly (typeof AI_PROVIDERS)[number][]
}) {
  if (!providers.length) return null

  return (
    <section className="mt-8">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-[18px] font-semibold tracking-[-0.25px]">{label}</h2>
        <span className="rounded-full bg-[var(--app-active)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--app-muted)]">{providers.length}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {providers.map((provider) => (
          <ProviderCard configuration={configurations.get(provider.id)} key={provider.id} provider={provider} />
        ))}
      </div>
    </section>
  )
}

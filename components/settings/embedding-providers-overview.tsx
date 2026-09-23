'use client'

import { EmbeddingProviderCard } from '@/components/settings/embedding-provider-card'
import type { EmbeddingProviderConfigurationSummary } from '@/lib/ai-provider-types'
import { EMBEDDING_PROVIDERS } from '@/lib/embedding-providers'
import { useT } from '@/lib/i18n/client'

export function EmbeddingProvidersOverview({ configurations }: { configurations: EmbeddingProviderConfigurationSummary[] }) {
  const t = useT()
  const map = new Map(configurations.map((item) => [item.providerId, item]))
  const enabled = EMBEDDING_PROVIDERS.filter((provider) => map.get(provider.id)?.enabled)
  const disabled = EMBEDDING_PROVIDERS.filter((provider) => !map.get(provider.id)?.enabled)
  return <main className="h-full min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"><div className="mx-auto w-full max-w-[1024px] pb-12"><header><h1 className="text-[24px] font-semibold tracking-[-0.55px]">{t("向量模型")}</h1><p className="mt-1.5 max-w-[720px] text-sm leading-[22px] text-[var(--app-muted)]">{t("配置知识库和 Zero 使用的 Embedding 模型。向量配置和普通聊天模型隔离保存，密钥只会交给可信的 Knowledge Service。")}</p></header><section className="mt-5 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-4 text-sm leading-5 text-[var(--app-muted)]">{t("Zero 只负责索引与检索。变更默认模型或向量维度后，已有知识库必须以新模型重新建立索引，避免把不同向量空间混入同一集合。")}</section>{enabled.length > 0 && <Grid configurations={map} label={t("已启用向量服务")} providers={enabled} />}<Grid configurations={map} label={t("未启用向量服务")} providers={disabled} /></div></main>
}

function Grid({ configurations, label, providers }: { configurations: Map<string, EmbeddingProviderConfigurationSummary>; label: string; providers: readonly (typeof EMBEDDING_PROVIDERS)[number][] }) {
  if (!providers.length) return null
  return <section className="mt-8"><div className="mb-4 flex items-center gap-2"><h2 className="text-[18px] font-semibold tracking-[-0.25px]">{label}</h2><span className="rounded-full bg-[var(--app-active)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--app-muted)]">{providers.length}</span></div><div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{providers.map((provider) => <EmbeddingProviderCard configuration={configurations.get(provider.id)} key={provider.id} provider={provider} />)}</div></section>
}

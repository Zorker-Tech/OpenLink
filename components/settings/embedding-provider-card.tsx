'use client'

import { ProviderLogo } from '@/components/settings/provider-logo'
import type { EmbeddingProviderConfigurationSummary } from '@/lib/ai-provider-types'
import type { EmbeddingProviderDefinition } from '@/lib/embedding-providers'
import { useT } from '@/lib/i18n/client'
import { ArrowUpRight, Database } from 'lucide-react'
import Link from 'next/link'

export function EmbeddingProviderCard({ configuration, provider }: { configuration?: EmbeddingProviderConfigurationSummary; provider: EmbeddingProviderDefinition }) {
  const t = useT()
  return <Link className="group flex min-h-36 flex-col rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-4 transition-colors hover:bg-[var(--app-hover)]" href={`/settings/ai-providers/embeddings/${provider.id}`}>
    <div className="flex items-start gap-3"><ProviderLogo provider={provider} size={30} /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-medium">{provider.name}</h3>{configuration?.enabled && <span className="size-1.5 rounded-full bg-[var(--app-success)]" />}</div><p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--app-muted)]">{t(provider.description)}</p></div><ArrowUpRight className="size-4 text-[var(--app-subtle)] transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></div>
    <div className="mt-auto flex items-center gap-1.5 pt-4 text-[11px] text-[var(--app-subtle)]"><Database className="size-3.5" /><span>{configuration?.defaultModelId || provider.defaultModelId || t('配置模型')}</span>{configuration?.vectorDimension && <><span>·</span><span>{t('{dimension} 维', { dimension: configuration.vectorDimension })}</span></>}</div>
  </Link>
}

'use client'

import { ProviderLogo } from '@/components/settings/provider-logo'
import type { AiProviderConfigurationSummary, EmbeddingProviderConfigurationSummary } from '@/lib/ai-provider-types'
import { AI_PROVIDERS } from '@/lib/ai-providers'
import { EMBEDDING_PROVIDERS } from '@/lib/embedding-providers'
import { useT } from '@/lib/i18n/client'
import { ChevronDown, Search, Sparkles, WalletCards, X } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'

export function ProviderNavigation({ configurations, currentProviderId, embeddingConfigurations = [], mode = 'chat' }: { configurations: AiProviderConfigurationSummary[]; currentProviderId?: string; embeddingConfigurations?: EmbeddingProviderConfigurationSummary[]; mode?: 'chat' | 'embedding' }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState({ disabled: true, enabled: true })
  const definitions = mode === 'embedding' ? EMBEDDING_PROVIDERS : AI_PROVIDERS
  const activeConfigurations = mode === 'embedding' ? embeddingConfigurations : configurations
  const configurationMap = useMemo(() => new Map(activeConfigurations.map((item) => [item.providerId, item])), [activeConfigurations])
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return term ? definitions.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(term)) : definitions
  }, [definitions, query])
  const enabled = filtered.filter((item) => configurationMap.get(item.id)?.enabled)
  const disabled = filtered.filter((item) => !configurationMap.get(item.id)?.enabled)

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-surface)] sm:w-[280px]">
      <div className="sticky top-0 z-10 flex h-[53px] items-center border-b border-[var(--app-border)] bg-[var(--app-surface)] p-2">
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-md bg-[var(--app-background)] px-2 transition-colors focus-within:bg-[var(--app-active)]">
          <Search className="size-4 shrink-0 text-[var(--app-subtle)]" strokeWidth={1.8} />
          <input
            aria-label={t('搜索服务商')}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-[var(--app-subtle)]"
            data-1p-ignore="true"
            data-lpignore="true"
            name="openlink-provider-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('搜索服务商…')}
            spellCheck={false}
            value={query}
          />
          {query && <button aria-label={t('清空搜索')} className="flex size-6 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-hover)]" onClick={() => setQuery('')} type="button"><X className="size-3.5" /></button>}
        </div>
      </div>

      <div className="flex gap-1 border-b border-[var(--app-border)] px-2 py-2">
        <Link className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium ${mode === 'chat' ? 'bg-[var(--app-selected)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'}`} href="/settings/ai-providers"><WalletCards className="size-3.5" />{t('普通')}</Link>
        <Link className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium ${mode === 'embedding' ? 'bg-[var(--app-selected)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'}`} href="/settings/ai-providers/embeddings"><Sparkles className="size-3.5" />{t('向量')}</Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-8 pt-2">
        <Link className={`flex h-9 items-center gap-2 rounded-md px-2 text-sm ${!currentProviderId ? 'bg-[var(--app-selected)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`} href={mode === 'embedding' ? '/settings/ai-providers/embeddings' : '/settings/ai-providers'}>
          <span className="flex size-[22px] shrink-0 items-center justify-center"><WalletCards className="size-[18px]" strokeWidth={1.7} /></span>
          <span>{mode === 'embedding' ? t('全部向量模型') : t('全部')}</span>
        </Link>

        {enabled.length > 0 && (
          <ProviderGroup
            configurations={configurationMap}
            currentProviderId={currentProviderId}
            expanded={expanded.enabled || Boolean(query)}
            label={t('已启用')}
            providers={enabled}
            mode={mode}
            onExpandedChange={() => setExpanded((value) => ({ ...value, enabled: !value.enabled }))}
          />
        )}
        <ProviderGroup
          configurations={configurationMap}
          currentProviderId={currentProviderId}
          expanded={expanded.disabled || Boolean(query)}
          label={t('未启用')}
          providers={disabled}
          mode={mode}
          onExpandedChange={() => setExpanded((value) => ({ ...value, disabled: !value.disabled }))}
        />
      </div>
    </aside>
  )
}

function ProviderGroup({ configurations, currentProviderId, expanded, label, mode, onExpandedChange, providers }: {
  configurations: Map<string, AiProviderConfigurationSummary | EmbeddingProviderConfigurationSummary>
  currentProviderId?: string
  expanded: boolean
  label: string
  onExpandedChange: () => void
  providers: ReadonlyArray<{ id: string; name: string; logo: string }>
  mode: 'chat' | 'embedding'
}) {
  const t = useT()
  if (!providers.length) return null

  return (
    <section className="mt-1">
      <button aria-expanded={expanded} className="group flex h-8 w-full items-center justify-between rounded-md px-2 text-xs font-medium text-[var(--app-subtle)] hover:bg-[var(--app-hover)]" onClick={onExpandedChange} type="button">
        <span>{label}</span>
        <ChevronDown className={`size-3.5 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} strokeWidth={1.8} />
      </button>
      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-0.5 py-0.5">
            {providers.map((provider) => {
              const active = currentProviderId === provider.id
              const configuration = configurations.get(provider.id)
              return (
                <Link className={`flex h-9 items-center gap-2 rounded-md px-2 text-sm ${active ? 'bg-[var(--app-selected)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`} href={mode === 'embedding' ? `/settings/ai-providers/embeddings/${provider.id}` : `/settings/ai-providers/${provider.id}`} key={provider.id}>
                  <ProviderLogo provider={provider} size={22} />
                  <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                  {configuration?.enabled && <span aria-label={t('已启用')} className="mr-1 size-1.5 rounded-full bg-[var(--app-success)]" />}
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

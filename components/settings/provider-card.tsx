'use client'

import { toggleAiProviderEnabledAction } from '@/app/settings/actions'
import { ProviderBrand } from '@/components/settings/provider-logo'
import { Switch } from '@/components/ui/switch'
import type { AiProviderConfigurationSummary } from '@/lib/ai-provider-types'
import type { AiProviderDefinition } from '@/lib/ai-providers'
import { useT } from '@/lib/i18n/client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useOptimistic, useTransition } from 'react'

interface ProviderCardProps {
  configuration?: AiProviderConfigurationSummary
  provider: AiProviderDefinition
}

export function ProviderCard({ configuration, provider }: ProviderCardProps) {
  const t = useT()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [enabled, setOptimisticEnabled] = useOptimistic(configuration?.enabled ?? false)
  const descriptionId = `provider-${provider.id}-description`

  const toggle = () => {
    const next = !enabled
    if (next && !configuration?.defaultModelId) {
      router.push(`/settings/ai-providers/${provider.id}`)
      return
    }

    startTransition(async () => {
      setOptimisticEnabled(next)
      const result = await toggleAiProviderEnabledAction(provider.id, next)
      if (!result.ok && result.error === 'PROVIDER_CONFIGURATION_REQUIRED') {
        router.push(`/settings/ai-providers/${provider.id}`)
        return
      }
      router.refresh()
    })
  }

  return (
    <article className="group relative h-[173px] overflow-hidden rounded-xl bg-[var(--app-surface)] shadow-[inset_0_0_0_1px_var(--app-border)] transition-[box-shadow,background-color] duration-200 hover:bg-[color-mix(in_srgb,var(--app-surface)_94%,var(--app-foreground)_6%)] hover:shadow-[inset_0_0_0_1px_var(--app-control-border)]">
      <div className="flex size-full flex-col gap-3 p-4">
        <Link
          aria-describedby={descriptionId}
          className="flex min-h-0 flex-1 flex-col gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]"
          href={`/settings/ai-providers/${provider.id}`}
        >
          <ProviderBrand provider={provider} size={24} />
          <p className="line-clamp-2 h-11 text-sm leading-[22px] text-[var(--app-muted)]" id={descriptionId}>
            {t(provider.description)}
          </p>
        </Link>

        <div className="py-1">
          <div className="h-px w-full bg-[var(--app-border)]" />
        </div>

        <div className="flex h-4 items-center">
          <Switch
            aria-label={enabled ? t('停用 {name}', { name: provider.name }) : t('启用 {name}', { name: provider.name })}
            checked={enabled}
            disabled={pending}
            onCheckedChange={toggle}
            size="card"
          />
        </div>
      </div>
    </article>
  )
}

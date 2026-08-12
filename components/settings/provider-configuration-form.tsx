'use client'

import { checkAiProviderConfigurationAction, saveAiProviderConfigurationAction } from '@/app/settings/actions'
import { ProviderBrand, ProviderLogo } from '@/components/settings/provider-logo'
import { AppSelect } from '@/components/ui/app-select'
import type { AiProviderConfigurationSummary, AiProviderModel } from '@/lib/ai-provider-types'
import type { AiProviderDefinition } from '@/lib/ai-providers'
import { Check, CircleHelp, Eye, EyeOff, Loader2, LockKeyhole, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { useMemo, useState, useTransition } from 'react'

interface ProviderConfigurationFormProps {
  configuration: AiProviderConfigurationSummary | null
  models: AiProviderModel[]
  provider: AiProviderDefinition
}

export function ProviderConfigurationForm({ configuration, models, provider }: ProviderConfigurationFormProps) {
  const initialModel = configuration?.defaultModelId && models.some((model) => model.id === configuration.defaultModelId)
    ? configuration.defaultModelId
    : models[0]?.id ?? ''
  const [enabled, setEnabled] = useState(configuration?.enabled ?? false)
  const [isDefault, setIsDefault] = useState(configuration?.isDefault ?? false)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(configuration?.baseUrl ?? provider.baseUrl ?? '')
  const [defaultModelId, setDefaultModelId] = useState(initialModel)
  const [enabledModels, setEnabledModels] = useState(() => new Set(configuration?.enabledModelIds.length ? configuration.enabledModelIds : initialModel ? [initialModel] : []))
  const [modelQuery, setModelQuery] = useState('')
  const [customModelId, setCustomModelId] = useState('')
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [checking, startChecking] = useTransition()
  const oauthOnly = provider.authMode === 'oauth'
  const ambientCredentials = provider.authMode === 'ambient'
  const dynamicCatalog = models.length === 0

  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    return query ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query)) : models
  }, [modelQuery, models])

  const save = () => startTransition(async () => {
    setStatus(null)
    const result = await saveAiProviderConfigurationAction({
      providerId: provider.id,
      enabled: oauthOnly ? false : enabled,
      isDefault,
      baseUrl,
      defaultModelId,
      enabledModelIds: [...enabledModels],
      apiKey: apiKey || undefined,
    })
    if (!result.ok) { setStatus({ kind: 'error', message: translateError(result.error) }); return }
    setApiKey('')
    setStatus({ kind: 'success', message: '配置已安全保存' })
  })

  const check = () => startChecking(async () => {
    setStatus(null)
    const saved = await saveAiProviderConfigurationAction({
      providerId: provider.id,
      enabled: true,
      isDefault,
      baseUrl,
      defaultModelId,
      enabledModelIds: [...enabledModels],
      apiKey: apiKey || undefined,
    })
    if (!saved.ok) { setStatus({ kind: 'error', message: translateError(saved.error) }); return }
    setApiKey('')
    const result = await checkAiProviderConfigurationAction(provider.id, defaultModelId)
    setStatus(result.ok
      ? { kind: 'success', message: 'Agent Host 已通过真实模型请求验证连接' }
      : { kind: 'error', message: translateError(result.error) })
  })

  const toggleModel = (modelId: string) => {
    setEnabledModels((current) => {
      const next = new Set(current)
      if (next.has(modelId) && modelId !== defaultModelId) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-[1024px] pb-12">
        <section className="rounded-xl bg-[var(--app-surface)] p-4 shadow-[inset_0_0_0_1px_var(--app-border)]">
        <div className={`flex min-h-9 items-center gap-3 ${enabled || oauthOnly ? '' : 'opacity-65 grayscale'}`}>
          <ProviderBrand provider={provider} size={24} />
          <a aria-label={`${provider.name} 帮助文档`} className="flex size-5 items-center justify-center rounded-full bg-[var(--app-active)] text-[var(--app-subtle)] hover:text-[var(--app-foreground)]" href={provider.baseUrl ?? undefined} rel="noreferrer" target="_blank"><CircleHelp className="size-3.5" /></a>
          <div className="min-w-0 flex-1" />
          <Toggle checked={enabled && !oauthOnly} disabled={oauthOnly} label="启用服务商" onChange={(value) => { setEnabled(value); if (value) setIsDefault(configuration?.isDefault ?? true) }} />
        </div>

        {oauthOnly ? (
          <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-5 text-amber-200">
            <div className="font-medium">此服务商使用 Pi OAuth</div>
            <p className="mt-1 text-amber-200/75">OpenAI Codex 需要 ChatGPT 订阅授权与令牌刷新，不能安全地当作普通 API Key 保存。本页面已纳入 Provider 目录；启用操作将在 Agent Host OAuth 回调流程接入后开放。</p>
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[var(--app-border)]">
            <ConfigRow description={ambientCredentials ? '使用 Agent Host 所在环境的 AWS/GCP 凭证链，不会把密钥写入项目配置。' : `请填写你的 ${provider.apiKeyLabel}`} label={ambientCredentials ? '环境凭证' : 'API Key'}>
              <div className="relative w-full max-w-[348px]">
                <input autoComplete="new-password" className="h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 pr-10 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" data-1p-ignore="true" data-form-type="other" data-lpignore="true" name={`openlink-${provider.id}-api-credential`} onChange={(event) => setApiKey(event.target.value)} placeholder={configuration?.apiKeyHint ?? `输入 ${provider.apiKeyLabel}`} spellCheck={false} type={showApiKey ? 'text' : 'password'} value={apiKey} />
                <button aria-label={showApiKey ? '隐藏密钥' : '显示密钥'} className="absolute right-1 top-1 flex size-7 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-hover)]" onClick={() => setShowApiKey((value) => !value)} type="button">{showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
              </div>
            </ConfigRow>
            <ConfigRow description="必须包含 http(s)://；留空时使用 Pi 内置端点。" label="API 代理地址">
              <input className="h-9 w-full max-w-[348px] rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider.baseUrl ?? 'https://your-provider.example/v1'} value={baseUrl} />
            </ConfigRow>
            <ConfigRow description="新建聊天默认使用此服务商和模型。" label="设为默认服务商">
              <Toggle checked={isDefault} label="设为默认服务商" onChange={setIsDefault} />
            </ConfigRow>
            <ConfigRow description="通过隔离运行时向当前模型发送最小请求。" label="连通性检查">
              <div className="flex w-full max-w-[348px] gap-2">
                {dynamicCatalog
                  ? <input className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm outline-none" onChange={(event) => { setDefaultModelId(event.target.value); setEnabledModels(new Set(event.target.value ? [event.target.value] : [])) }} placeholder="provider/model-id" value={defaultModelId} />
                  : <AppSelect ariaLabel="连接检查模型" className="min-w-0 flex-1" contentClassName="max-w-[520px]" onValueChange={(modelId) => { setDefaultModelId(modelId); setEnabledModels((current) => new Set(current).add(modelId)) }} options={models.map((model) => ({ description: model.id, icon: <ProviderLogo provider={provider} size={20} />, label: model.name, value: model.id }))} value={defaultModelId} />}
                <button className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm font-medium hover:bg-[var(--app-hover)] disabled:opacity-50" disabled={checking || !defaultModelId} onClick={check} type="button">{checking ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}检查</button>
              </div>
            </ConfigRow>
          </div>
        )}

        <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-[var(--app-subtle)]"><LockKeyhole className="size-3" />你的密钥使用 AES-256-GCM 加密；Web/远程工作负载仅接收 Vault 占位符，桌面运行时使用受控掩码注入。</div>
        </section>

        <section className="mt-8">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="mr-auto text-lg font-semibold">模型列表</h2>
            <div className="flex h-8 w-56 items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2"><Search className="size-3.5 text-[var(--app-muted)]" /><input className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none" onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型…" value={modelQuery} /></div>
            <button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2.5 text-xs text-[var(--app-muted)]"><RefreshCw className="size-3.5" />Pi 目录</button>
          </div>
          <div className="mt-4 space-y-1">
            {dynamicCatalog && !oauthOnly && (
              <div className="flex min-h-[62px] items-center gap-2 rounded-lg px-3 py-3 hover:bg-[var(--app-hover)]">
                <input className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 font-mono text-sm outline-none" onChange={(event) => setCustomModelId(event.target.value)} placeholder="输入动态网关中的模型 ID" value={customModelId} />
                <button className="h-9 rounded-md border border-[var(--app-control-border)] px-3 text-sm hover:bg-[var(--app-hover)]" onClick={() => { const id = customModelId.trim(); if (!id) return; setDefaultModelId(id); setEnabledModels(new Set([id])); setCustomModelId('') }} type="button">添加</button>
              </div>
            )}
            {dynamicCatalog && defaultModelId && (
              <div className="flex min-h-[62px] items-center gap-3 rounded-lg px-3 py-3 hover:bg-[var(--app-hover)]">
                <span className="flex size-5 items-center justify-center rounded border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] text-[var(--app-submit-foreground)]"><Check className="size-3.5" /></span>
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{defaultModelId}</div><div className="mt-1 text-[11px] text-[var(--app-subtle)]">动态 Provider 模型 · 默认</div></div>
              </div>
            )}
            {visibleModels.map((model) => {
              const selected = enabledModels.has(model.id)
              const defaultModel = defaultModelId === model.id
              return (
                <div className="group flex min-h-[64px] items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--app-hover)]" key={model.id}>
                  <ProviderLogo provider={provider} size={32} />
                  <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{model.name}</span><button className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] ${defaultModel ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'bg-[var(--app-surface)] text-[var(--app-subtle)]'}`} disabled={oauthOnly || !selected} onClick={() => { setDefaultModelId(model.id); setEnabledModels((current) => new Set(current).add(model.id)) }} type="button">{defaultModel ? '默认' : model.id}</button>{model.reasoning && <span className="rounded-full bg-[var(--app-active)] px-2 py-0.5 text-[10px] text-[var(--app-muted)]">Reasoning</span>}</div><div className="mt-1 truncate text-xs text-[var(--app-subtle)]">{model.id} · {formatTokens(model.contextWindow)} context · 输入 ${model.cost.input}/M · 输出 ${model.cost.output}/M</div></div>
                  <Toggle checked={selected} disabled={oauthOnly} label={`${selected ? '停用' : '启用'} ${model.name}`} onChange={() => toggleModel(model.id)} size="small" />
                </div>
              )
            })}
          </div>
        </section>

        <div className="sticky bottom-0 mt-6 flex items-center justify-end gap-3 border-t border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-background)_92%,transparent)] py-4 backdrop-blur-xl">
          {status && <span className={`mr-auto text-sm ${status.kind === 'success' ? 'text-emerald-500' : 'text-red-400'}`}>{status.message}</span>}
          <button className="flex h-9 items-center gap-2 rounded-md bg-[var(--app-submit-background)] px-4 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-50" disabled={pending || !defaultModelId} onClick={save} type="button">{pending && <Loader2 className="size-4 animate-spin" />}保存配置</button>
        </div>
      </div>
    </main>
  )
}

function Toggle({ checked, disabled, label, onChange, size = 'default' }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void; size?: 'small' | 'default' }) {
  const small = size === 'small'
  return <button aria-label={label} aria-pressed={checked} className={`relative shrink-0 rounded-full transition-colors ${small ? 'h-4 w-7' : 'h-[22px] w-11'} ${checked ? 'bg-[#1677ff]' : 'bg-[var(--app-active)]'} disabled:cursor-not-allowed disabled:opacity-40`} disabled={disabled} onClick={() => onChange(!checked)} type="button"><span className={`absolute left-0 rounded-full bg-[var(--app-background)] shadow-[0_1px_1px_rgba(0,0,0,.08),0_3px_8px_rgba(0,30,80,.16)] transition-transform ${small ? `top-0.5 size-3 ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}` : `top-0.5 size-[18px] ${checked ? 'translate-x-6' : 'translate-x-0.5'}`}`} /></button>
}

function ConfigRow({ children, description, label }: { children: React.ReactNode; description: string; label: string }) {
  return <div className="flex min-h-[74px] flex-col gap-3 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><div className="mt-1 text-xs text-[var(--app-muted)]">{description}</div></div><div className="flex w-full justify-end sm:w-[348px]">{children}</div></div>
}

function translateError(error: string) {
  if (error === 'PROVIDER_API_KEY_REQUIRED') return '启用此服务商前需要填写 API Key。'
  if (error === 'PROVIDER_CREDENTIAL_REKEY_REQUIRED') return '已保存的密钥无法解密，请重新输入 API Key 并保存。'
  if (error === 'MODEL_NOT_ENABLED') return '当前模型尚未启用。'
  if (error === 'AGENT_HOST_NOT_CONFIGURED') return 'Agent Host 尚未启动。'
  if (error.includes('fetch failed')) return '无法连接 Agent Host 或模型服务。'
  return error
}

function formatTokens(tokens: number) {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}K`
}

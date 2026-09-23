'use client'

import { checkAiProviderConfigurationAction, fetchProviderModelsAction, saveAiProviderConfigurationAction } from '@/app/settings/actions'
import { ProviderBrand, ProviderLogo } from '@/components/settings/provider-logo'
import { AppSelect } from '@/components/ui/app-select'
import type { AiProviderConfigurationSummary, AiProviderModel, ProviderModelParams } from '@/lib/ai-provider-types'
import type { AiProviderDefinition } from '@/lib/ai-providers'
import { useT } from '@/lib/i18n/client'
import { CircleHelp, Eye, EyeOff, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { useMemo, useState, useTransition } from 'react'

interface ProviderConfigurationFormProps {
  configuration: AiProviderConfigurationSummary | null
  models: AiProviderModel[]
  provider: AiProviderDefinition
}

interface ModelRecord {
  id: string
  name: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

function catalogRecord(model: AiProviderModel): ModelRecord {
  return {
    id: model.id,
    name: model.name,
    reasoning: Boolean(model.reasoning),
    input: Array.isArray(model.input) && model.input.length ? model.input : ['text'],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  }
}

function paramRecord(id: string, params: ProviderModelParams): ModelRecord {
  return {
    id,
    name: params.name || id,
    reasoning: Boolean(params.reasoning),
    input: Array.isArray(params.input) && params.input.length ? params.input : ['text'],
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
    cost: params.cost,
  }
}

function toParams(record: ModelRecord | undefined, modelId: string): ProviderModelParams {
  const fallback: ProviderModelParams = {
    name: modelId,
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0 },
  }
  if (!record) return fallback
  return {
    name: record.name,
    reasoning: record.reasoning,
    input: record.input,
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    cost: record.cost,
  }
}


export function ProviderConfigurationForm({ configuration, models, provider }: ProviderConfigurationFormProps) {
  const t = useT()
  const initialModel = configuration?.defaultModelId && (models.some((model) => model.id === configuration.defaultModelId) || !models.length)
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
  const [fetching, startFetching] = useTransition()
  const [modelParams, setModelParams] = useState<Record<string, ProviderModelParams>>(() => ({ ...(configuration?.modelParams ?? {}) }))
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<ModelRecord | null>(null)
  const oauthOnly = provider.authMode === 'oauth'
  const ambientCredentials = provider.authMode === 'ambient'
  const dynamicCatalog = models.length === 0

  // Unified model list: catalog models overlaid with persisted params and any
  // models fetched from upstream, so every model shows its parameters.
  const modelRecords = useMemo(() => {
    const ids = new Set<string>([...models.map((model) => model.id), ...Object.keys(modelParams)])
    return [...ids].map((modelId) => {
      const catalog = models.find((model) => model.id === modelId)
      const record = catalog ? catalogRecord(catalog) : paramRecord(modelId, modelParams[modelId])
      const params = modelParams[modelId]
      if (params) {
        return {
          ...record,
          name: params.name || record.name,
          reasoning: Boolean(params.reasoning),
          input: params.input?.length ? params.input : record.input,
          contextWindow: params.contextWindow,
          maxTokens: params.maxTokens,
          cost: params.cost,
        }
      }
      return record
    })
  }, [models, modelParams])

  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    return query ? modelRecords.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query)) : modelRecords
  }, [modelQuery, modelRecords])

  const save = () => startTransition(async () => {
    setStatus(null)
    const result = await saveAiProviderConfigurationAction({
      providerId: provider.id,
      enabled: oauthOnly ? false : enabled,
      isDefault,
      baseUrl,
      defaultModelId,
      enabledModelIds: [...enabledModels],
      modelParams,
      apiKey: apiKey || undefined,
    })
    if (!result.ok) { setStatus({ kind: 'error', message: translateError(result.error, t) }); return }
    setApiKey('')
    setStatus({ kind: 'success', message: t('配置已安全保存') })
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
      modelParams,
      apiKey: apiKey || undefined,
    })
    if (!saved.ok) { setStatus({ kind: 'error', message: translateError(saved.error, t) }); return }
    setApiKey('')
    const result = await checkAiProviderConfigurationAction(provider.id, defaultModelId)
    setStatus(result.ok
      ? { kind: 'success', message: t('Agent Host 已通过真实模型请求验证连接') }
      : { kind: 'error', message: translateError(result.error, t) })
  })

  const toggleModel = (modelId: string) => {
    setEnabledModels((current) => {
      const next = new Set(current)
      if (next.has(modelId) && modelId !== defaultModelId) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }

  const addCustomModel = (rawId: string) => {
    const id = rawId.trim()
    if (!id) return
    setModelParams((current) => ({ ...current, [id]: toParams(undefined, id) }))
    setEnabledModels((current) => new Set(current).add(id))
    setDefaultModelId((current) => current || id)
    setCustomModelId('')
  }

  const removeModel = (modelId: string) => {
    setModelParams((current) => {
      const next = { ...current }
      delete next[modelId]
      return next
    })
    setEnabledModels((current) => {
      const next = new Set(current)
      next.delete(modelId)
      return next
    })
    if (defaultModelId === modelId) {
      const remaining = modelRecords.find((model) => model.id !== modelId)
      setDefaultModelId(remaining?.id ?? '')
    }
  }

  const startEdit = (modelId: string) => {
    const record = modelRecords.find((model) => model.id === modelId)
    setEditingModelId(modelId)
    setEditingDraft(record ? { ...record, cost: { ...record.cost } } : null)
  }

  const cancelEdit = () => {
    setEditingModelId(null)
    setEditingDraft(null)
  }

  const saveEdit = () => {
    if (!editingModelId || !editingDraft) return
    setModelParams((current) => ({ ...current, [editingModelId]: toParams(editingDraft, editingModelId) }))
    setEditingModelId(null)
    setEditingDraft(null)
  }

  const fetchModels = () => startFetching(async () => {
    setStatus(null)
    if (!baseUrl.trim()) { setStatus({ kind: 'error', message: t('请先填写 API 代理地址') }); return }
    const result = await fetchProviderModelsAction({ providerId: provider.id, baseUrl, apiKey: apiKey || undefined })
    if (!result.ok || !result.models) { setStatus({ kind: 'error', message: translateError(result.error, t) }); return }
    const upserted = { ...modelParams }
    const enabled = new Set(enabledModels)
    for (const model of result.models) {
      upserted[model.id] = { ...toParams(undefined, model.id), ...model }
      enabled.add(model.id)
    }
    setModelParams(upserted)
    setEnabledModels(enabled)
    if (!defaultModelId) {
      const first = result.models[0]
      if (first) setDefaultModelId(first.id)
    }
    setStatus({ kind: 'success', message: t('已从上游获取 {count} 个模型，请在下方启用并编辑参数', { count: result.models.length }) })
  })

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-[1024px] pb-12">
        <section className="rounded-xl bg-[var(--app-surface)] p-4 shadow-[inset_0_0_0_1px_var(--app-border)]">
        <div className={`flex min-h-9 items-center gap-3 ${enabled || oauthOnly ? '' : 'opacity-65 grayscale'}`}>
          <ProviderBrand provider={provider} size={24} />
          <a aria-label={t('{name} 帮助文档', { name: provider.name })} className="flex size-5 items-center justify-center rounded-full bg-[var(--app-active)] text-[var(--app-subtle)] hover:text-[var(--app-foreground)]" href={provider.baseUrl ?? undefined} rel="noreferrer" target="_blank"><CircleHelp className="size-3.5" /></a>
          <div className="min-w-0 flex-1" />
          <Toggle checked={enabled && !oauthOnly} disabled={oauthOnly} label={t('启用服务商')} onChange={(value) => { setEnabled(value); if (value) setIsDefault(configuration?.isDefault ?? true) }} />
        </div>

        {oauthOnly ? (
          <div className="mt-6 rounded-lg border border-[var(--app-warning)] bg-[var(--app-warning-surface)] p-4 text-sm leading-5 text-[var(--app-warning)]">
            <div className="font-medium">{t('此服务商使用 Pi OAuth')}</div>
            <p className="mt-1 opacity-80">{t('OpenAI Codex 需要 ChatGPT 订阅授权与令牌刷新，不能安全地当作普通 API Key 保存。本页面已纳入 Provider 目录；启用操作将在 Agent Host OAuth 回调流程接入后开放。')}</p>
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[var(--app-border)]">
            <ConfigRow description={ambientCredentials ? t('使用 Agent Host 所在环境的 AWS/GCP 凭证链，不会把密钥写入项目配置。') : t('请填写你的 {apiKeyLabel}', { apiKeyLabel: t(provider.apiKeyLabel) })} label={ambientCredentials ? t('环境凭证') : 'API Key'}>
              <div className="relative w-full max-w-[348px]">
                <input autoComplete="new-password" className="h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 pr-10 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" data-1p-ignore="true" data-form-type="other" data-lpignore="true" name={`openlink-${provider.id}-api-credential`} onChange={(event) => setApiKey(event.target.value)} placeholder={configuration?.apiKeyHint ?? t('输入 {apiKeyLabel}', { apiKeyLabel: t(provider.apiKeyLabel) })} spellCheck={false} type={showApiKey ? 'text' : 'password'} value={apiKey} />
                <button aria-label={showApiKey ? t('隐藏密钥') : t('显示密钥')} className="absolute right-1 top-1 flex size-7 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-hover)]" onClick={() => setShowApiKey((value) => !value)} type="button">{showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
              </div>
            </ConfigRow>
            <ConfigRow description={t('必须包含 http(s)://；留空时使用 Pi 内置端点。')} label={t('API 代理地址')}>
              <input className="h-9 w-full max-w-[348px] rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider.baseUrl ?? 'https://your-provider.example/v1'} value={baseUrl} />
            </ConfigRow>
            <ConfigRow description={t('新建聊天默认使用此服务商和模型。')} label={t('设为默认服务商')}>
              <Toggle checked={isDefault} label={t('设为默认服务商')} onChange={setIsDefault} />
            </ConfigRow>
            <ConfigRow description={t('通过隔离运行时向当前模型发送最小请求。')} label={t('连通性检查')}>
              <div className="flex w-full max-w-[348px] gap-2">
                {dynamicCatalog
                  ? <input className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm outline-none" onChange={(event) => { const value = event.target.value; setDefaultModelId(value); if (value) setEnabledModels((current) => new Set(current).add(value)) }} placeholder="provider/model-id" value={defaultModelId} />
                  : <AppSelect ariaLabel={t('连接检查模型')} className="min-w-0 flex-1" contentClassName="max-w-[520px]" onValueChange={(modelId) => { setDefaultModelId(modelId); setEnabledModels((current) => new Set(current).add(modelId)) }} options={models.map((model) => ({ description: model.id, icon: <ProviderLogo provider={provider} size={20} />, label: model.name, value: model.id }))} value={defaultModelId} />}
                <button className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm font-medium hover:bg-[var(--app-hover)] disabled:opacity-50" disabled={checking || !defaultModelId} onClick={check} type="button">{checking ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{t('检查')}</button>
              </div>
            </ConfigRow>
          </div>
        )}

        <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-[var(--app-subtle)]"><LockKeyhole className="size-3" />{t('你的密钥使用 AES-256-GCM 加密；Web/远程工作负载仅接收 Vault 占位符，桌面运行时使用受控掩码注入。')}</div>
        </section>

        <section className="mt-8">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="mr-auto text-lg font-semibold">{t('模型列表')}</h2>
            <div className="flex h-8 w-56 items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2"><Search className="size-3.5 text-[var(--app-muted)]" /><input className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none" onChange={(event) => setModelQuery(event.target.value)} placeholder={t('搜索模型…')} value={modelQuery} /></div>
            <button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2.5 text-xs text-[var(--app-muted)] disabled:opacity-50" disabled={fetching || (!baseUrl.trim() && !configuration?.baseUrl)} onClick={fetchModels} type="button">{fetching ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{t('获取模型')}</button>
          </div>
          {fetching && <p className="mt-2 text-xs text-[var(--app-subtle)]">{t('正在从上游获取模型与参数…')}</p>}
          <div className="mt-4 space-y-1">
            {dynamicCatalog && !oauthOnly && (
              <div className="flex min-h-[62px] items-center gap-2 rounded-lg px-3 py-3 hover:bg-[var(--app-hover)]">
                <input className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 font-mono text-sm outline-none" onChange={(event) => setCustomModelId(event.target.value)} placeholder={t('输入动态网关中的模型 ID')} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomModel(customModelId) } }} value={customModelId} />
                <button className="flex h-9 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-3 text-sm hover:bg-[var(--app-hover)]" onClick={() => addCustomModel(customModelId)} type="button"><Plus className="size-4" />{t('添加')}</button>
              </div>
            )}
            {visibleModels.length === 0 && !dynamicCatalog && <p className="px-2 py-1 text-xs text-[var(--app-subtle)]">{t('暂无模型，点击「获取模型」从上游拉取。')}</p>}
            {visibleModels.map((model) => {
              const selected = enabledModels.has(model.id)
              const defaultModel = defaultModelId === model.id
              const isEditing = editingModelId === model.id
              if (isEditing && editingDraft) {
                return (
                  <div className="flex min-h-[64px] flex-col gap-3 rounded-lg border border-[var(--app-focus-ring)] bg-[var(--app-surface)] px-3 py-3" key={model.id}>
                    <div className="flex items-center gap-2">
                      <ProviderLogo provider={provider} size={24} />
                      <span className="truncate text-sm font-medium">{model.id}</span>
                      <span className="ml-auto rounded-full bg-[var(--app-active)] px-2 py-0.5 text-[10px] text-[var(--app-subtle)]">{t('编辑参数')}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                      <label className="flex flex-col gap-1"><span className="text-[var(--app-subtle)]">{t("显示名称")}</span><input className="h-8 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setEditingDraft((draft) => draft ? { ...draft, name: event.target.value } : draft)} value={editingDraft.name} /></label>
                      <label className="flex flex-col gap-1"><span className="text-[var(--app-subtle)]">{t("上下文窗口 (tokens)")}</span><input className="h-8 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setEditingDraft((draft) => draft ? { ...draft, contextWindow: Number(event.target.value) || 0 } : draft)} type="number" value={editingDraft.contextWindow} /></label>
                      <label className="flex flex-col gap-1"><span className="text-[var(--app-subtle)]">{t("最大输出 (tokens)")}</span><input className="h-8 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setEditingDraft((draft) => draft ? { ...draft, maxTokens: Number(event.target.value) || 0 } : draft)} type="number" value={editingDraft.maxTokens} /></label>
                      <label className="flex flex-col gap-1"><span className="text-[var(--app-subtle)]">{t("输入成本 ($/M)")}</span><input className="h-8 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setEditingDraft((draft) => draft ? { ...draft, cost: { ...draft.cost, input: Number(event.target.value) || 0 } } : draft)} step="0.01" type="number" value={editingDraft.cost.input} /></label>
                      <label className="flex flex-col gap-1"><span className="text-[var(--app-subtle)]">{t("输出成本 ($/M)")}</span><input className="h-8 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setEditingDraft((draft) => draft ? { ...draft, cost: { ...draft.cost, output: Number(event.target.value) || 0 } } : draft)} step="0.01" type="number" value={editingDraft.cost.output} /></label>
                      <label className="flex items-end gap-2 pb-1"><span className="text-[var(--app-subtle)]">{t("推理")}</span><button aria-pressed={editingDraft.reasoning} className="relative h-[22px] w-11 rounded-full bg-[var(--app-active)] transition-colors disabled:cursor-not-allowed disabled:opacity-40" onClick={() => setEditingDraft((draft) => draft ? { ...draft, reasoning: !draft.reasoning } : draft)} type="button"><span className={`absolute left-0 top-0.5 size-[18px] rounded-full bg-[var(--app-surface)] shadow-[0_1px_1px_var(--app-shadow),0_3px_8px_var(--app-shadow)] transition-transform ${editingDraft.reasoning ? 'translate-x-6' : 'translate-x-0.5'}`} /></button></label>
                      <label className="flex items-end gap-2 pb-1"><span className="text-[var(--app-subtle)]">{t("多模态")}</span><button aria-pressed={editingDraft.input.includes('image')} className="relative h-[22px] w-11 rounded-full bg-[var(--app-active)] transition-colors" onClick={() => setEditingDraft((draft) => draft ? { ...draft, input: draft.input.includes('image') ? ['text'] : ['text', 'image'] } : draft)} type="button"><span className={`absolute left-0 top-0.5 size-[18px] rounded-full bg-[var(--app-surface)] shadow-[0_1px_1px_var(--app-shadow),0_3px_8px_var(--app-shadow)] transition-transform ${editingDraft.input.includes('image') ? 'translate-x-6' : 'translate-x-0.5'}`} /></button></label>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-3 text-sm hover:bg-[var(--app-hover)]" onClick={cancelEdit} type="button"><X className="size-4" />{t('取消')}</button>
                      <button className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:bg-[var(--app-submit-hover)]" onClick={saveEdit} type="button"><Save className="size-4" />{t('保存')}</button>
                    </div>
                  </div>
                )
              }
              return (
                <div className="group flex min-h-[64px] items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--app-hover)]" key={model.id}>
                  <ProviderLogo provider={provider} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{model.name}</span><button className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] ${defaultModel ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'bg-[var(--app-surface)] text-[var(--app-subtle)]'}`} disabled={oauthOnly || !selected} onClick={() => { setDefaultModelId(model.id); setEnabledModels((current) => new Set(current).add(model.id)) }} type="button">{defaultModel ? t("默认") : model.id}</button>{model.reasoning && <span className="rounded-full bg-[var(--app-active)] px-2 py-0.5 text-[10px] text-[var(--app-muted)]">Reasoning</span>}</div>
                    <div className="mt-1 truncate text-xs text-[var(--app-subtle)]">{model.id} · {formatTokens(model.contextWindow)} context · {t('输出上限')} {formatTokens(model.maxTokens)} · {t('输入')} ${model.cost.input}/M · {t('输出')} ${model.cost.output}/M</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button aria-label={t('编辑 {name}', { name: model.name })} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={() => startEdit(model.id)} type="button"><Pencil className="size-4" /></button>
                    <button aria-label={t('删除 {name}', { name: model.name })} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-danger)]" onClick={() => removeModel(model.id)} type="button"><Trash2 className="size-4" /></button>
                    <Toggle checked={selected} disabled={oauthOnly} label={selected ? t("停用 {name}", { name: model.name }) : t("启用 {name}", { name: model.name })} onChange={() => toggleModel(model.id)} size="small" />
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <div className="sticky bottom-0 mt-6 flex items-center justify-end gap-3 border-t border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-background)_92%,transparent)] py-4 backdrop-blur-xl">
          {status && <span className={`mr-auto text-sm ${status.kind === 'success' ? 'text-[var(--app-success)]' : 'text-[var(--app-danger)]'}`}>{status.message}</span>}
          <button className="flex h-9 items-center gap-2 rounded-md bg-[var(--app-submit-background)] px-4 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-50" disabled={pending || !defaultModelId} onClick={save} type="button">{pending && <Loader2 className="size-4 animate-spin" />}{t('保存配置')}</button>
        </div>
      </div>
    </main>
  )
}

function Toggle({ checked, disabled, label, onChange, size = 'default' }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void; size?: 'small' | 'default' }) {
  const small = size === 'small'
  return <button aria-label={label} aria-pressed={checked} className={`relative shrink-0 rounded-full transition-colors ${small ? 'h-4 w-7' : 'h-[22px] w-11'} ${checked ? 'bg-[var(--app-brand)]' : 'bg-[var(--app-active)]'} disabled:cursor-not-allowed disabled:opacity-40`} disabled={disabled} onClick={() => onChange(!checked)} type="button"><span className={`absolute left-0 rounded-full bg-[var(--app-surface)] shadow-[0_1px_1px_var(--app-shadow),0_3px_8px_var(--app-shadow)] transition-transform ${small ? `top-0.5 size-3 ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}` : `top-0.5 size-[18px] ${checked ? 'translate-x-6' : 'translate-x-0.5'}`}`} /></button>
}

function ConfigRow({ children, description, label }: { children: React.ReactNode; description: string; label: string }) {
  return <div className="flex min-h-[74px] flex-col gap-3 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><div className="mt-1 text-xs text-[var(--app-muted)]">{description}</div></div><div className="flex w-full justify-end sm:w-[348px]">{children}</div></div>
}

function translateError(error: string, t: (source: string) => string) {
  if (error === 'PROVIDER_API_KEY_REQUIRED') return t('启用此服务商前需要填写 API Key。')
  if (error === 'PROVIDER_CREDENTIAL_REKEY_REQUIRED') return t('已保存的密钥无法解密，请重新输入 API Key 并保存。')
  if (error === 'MODEL_NOT_ENABLED') return t('当前模型尚未启用。')
  if (error === 'MODEL_PARAMS_INVALID') return t('模型参数无效，请检查上下文窗口与最大输出限制。')
  if (error === 'AGENT_HOST_NOT_CONFIGURED') return t('Agent Host 尚未启动。')
  if (error === 'FETCH_MODELS_EMPTY') return t('上游未返回任何模型，请检查 Base URL 或 API Key。')
  if (error.startsWith('FETCH_MODELS_FAILED_')) return t('无法从上游获取模型，请检查 API 代理地址与 API Key。')
  if (error.includes('fetch failed')) return t('无法连接 Agent Host 或模型服务。')
  return error
}

function formatTokens(tokens: number) {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}K`
}

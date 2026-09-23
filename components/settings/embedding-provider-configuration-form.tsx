'use client'

import { saveEmbeddingProviderConfigurationAction } from '@/app/settings/actions'
import { ProviderBrand, ProviderLogo } from '@/components/settings/provider-logo'
import type { EmbeddingProviderConfigurationSummary } from '@/lib/ai-provider-types'
import type { EmbeddingProviderDefinition } from '@/lib/embedding-providers'
import { useT } from '@/lib/i18n/client'
import { Check, CircleHelp, Database, Download, Eye, EyeOff, Loader2, LockKeyhole } from 'lucide-react'
import { useState, useTransition } from 'react'

export function EmbeddingProviderConfigurationForm({ configuration, provider }: { configuration: EmbeddingProviderConfigurationSummary | null; provider: EmbeddingProviderDefinition }) {
  const t = useT()
  const [enabled, setEnabled] = useState(configuration?.enabled ?? false)
  const [isDefault, setIsDefault] = useState(configuration?.isDefault ?? false)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(configuration?.baseUrl ?? provider.baseUrl)
  const [modelId, setModelId] = useState(configuration?.defaultModelId ?? provider.defaultModelId)
  const [dimension, setDimension] = useState(String(configuration?.vectorDimension ?? provider.defaultDimension))
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const isOllama = provider.protocol === 'ollama'
  const isLocal = Boolean(provider.supportsLocalDownload)

  const save = () => startTransition(async () => {
    setStatus(null)
    const result = await saveEmbeddingProviderConfigurationAction({ providerId: provider.id, enabled, isDefault, baseUrl, protocol: provider.protocol, defaultModelId: modelId.trim(), vectorDimension: Number(dimension), apiKey: apiKey || undefined })
    if (!result.ok) { setStatus({ kind: 'error', message: translateError(result.error, t) }); return }
    setApiKey('')
    setStatus({ kind: 'success', message: result.configuration.isDefault ? t('向量模型已保存为知识库默认模型；现有索引将在重建后切换。') : t('向量模型配置已安全保存') })
  })

  return <main className="h-full min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"><div className="mx-auto w-full max-w-[1024px] pb-12">
    <section className="rounded-xl bg-[var(--app-surface)] p-4 shadow-[inset_0_0_0_1px_var(--app-border)]">
      <div className={`flex min-h-9 items-center gap-3 ${enabled ? '' : 'opacity-65 grayscale'}`}><ProviderBrand provider={provider} size={24} /><a aria-label={t('{name} 帮助文档', { name: provider.name })} className="flex size-5 items-center justify-center rounded-full bg-[var(--app-active)] text-[var(--app-subtle)] hover:text-[var(--app-foreground)]" href={provider.baseUrl || undefined} rel="noreferrer" target="_blank"><CircleHelp className="size-3.5" /></a><div className="min-w-0 flex-1" /><Toggle checked={enabled} label={t('启用向量服务')} onChange={(value) => { setEnabled(value); if (value) setIsDefault(configuration?.isDefault ?? true) }} /></div>
      <div className="mt-3 divide-y divide-[var(--app-border)]">
        <Row description={isOllama ? t('默认本机地址。Ollama 的兼容 API 不要求密钥。') : t('必须包含 http(s)://；可填写托管或本地 inference 服务地址。')} label={t('向量 API 地址')}><input className="h-9 w-full max-w-[348px] rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider.baseUrl} value={baseUrl} /></Row>
        <Row description={isOllama ? t('例如 nomic-embed-text、mxbai-embed-large、embeddinggemma。') : t('填写该服务实际提供的 embedding 模型 ID。')} label={t('向量模型')}><input className="h-9 w-full max-w-[348px] rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => setModelId(event.target.value)} placeholder={provider.defaultModelId || 'provider/model-id'} value={modelId} /></Row>
        <Row description={t('必须与该模型实际输出维度一致。模型或维度变更后，知识库需要重新建立 Zero 索引。')} label={t('向量维度')}><div className="relative w-full max-w-[348px]"><Database className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--app-subtle)]" /><input className="h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] pl-9 pr-3 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" inputMode="numeric" min="2" onChange={(event) => setDimension(event.target.value)} type="number" value={dimension} /></div></Row>
        <Row description={provider.apiKeyRequired ? t('请填写你的 {apiKeyLabel}', { apiKeyLabel: t(provider.apiKeyLabel) }) : t('{apiKeyLabel}；本地服务通常可留空。', { apiKeyLabel: t(provider.apiKeyLabel) })} label="API Key"><div className="relative w-full max-w-[348px]"><input autoComplete="new-password" className="h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 pr-10 font-mono text-sm outline-none focus:border-[var(--app-focus-ring)]" data-1p-ignore="true" data-lpignore="true" onChange={(event) => setApiKey(event.target.value)} placeholder={configuration?.apiKeyHint ?? t("输入 {apiKeyLabel}", { apiKeyLabel: t(provider.apiKeyLabel) })} type={showApiKey ? 'text' : 'password'} value={apiKey} /><button aria-label={showApiKey ? t("隐藏密钥") : t("显示密钥")} className="absolute right-1 top-1 flex size-7 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-hover)]" onClick={() => setShowApiKey((value) => !value)} type="button">{showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></Row>
        <Row description={t('知识库在未显式选择模型时使用这里的默认向量模型。')} label={t('设为默认向量模型')}><Toggle checked={isDefault} label={t('设为默认向量模型')} onChange={setIsDefault} /></Row>
      </div>
      <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-[var(--app-subtle)]"><LockKeyhole className="size-3" />{t('密钥经 AES-256-GCM 加密，只有 Knowledge Service 能在索引请求中解密使用。')}</div>
    </section>
    {isLocal && <section className="mt-6 rounded-xl border border-[var(--app-control-border)] bg-[var(--app-surface)] p-5"><div className="flex items-start gap-3"><Download className="mt-0.5 size-4" /><div><h2 className="text-sm font-semibold">{t("本地模型")}</h2><p className="mt-1 text-sm leading-5 text-[var(--app-muted)]">{isOllama ? t('安装并运行 Ollama 后，在系统终端执行 `ollama pull <模型名>`；保存后 OpenLink 会通过本机 API 使用该模型。') : t('Hugging Face Local 使用 TEI。下载模型并启动 TEI 服务后，把上方地址指向该服务即可；模型文件由 TEI 缓存与管理。')}</p></div></div></section>}
    <div className="sticky bottom-0 mt-6 flex items-center justify-end gap-3 border-t border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-background)_92%,transparent)] py-4 backdrop-blur-xl">{status && <span className={`mr-auto text-sm ${status.kind === 'success' ? 'text-[var(--app-success)]' : 'text-[var(--app-danger)]'}`}>{status.message}</span>}<button className="flex h-9 items-center gap-2 rounded-md bg-[var(--app-submit-background)] px-4 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-50" disabled={pending || !modelId.trim() || !Number.isFinite(Number(dimension))} onClick={save} type="button">{pending && <Loader2 className="size-4 animate-spin" />}{t('保存配置')}</button></div>
  </div></main>
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) { return <button aria-label={label} aria-pressed={checked} className={`relative h-[22px] w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-[var(--app-brand)]' : 'bg-[var(--app-active)]'}`} onClick={() => onChange(!checked)} type="button"><span className={`absolute left-0 top-0.5 size-[18px] rounded-full bg-[var(--app-surface)] shadow-[0_1px_1px_var(--app-shadow),0_3px_8px_var(--app-shadow)] transition-transform ${checked ? 'translate-x-6' : 'translate-x-0.5'}`} /></button> }
function Row({ children, description, label }: { children: React.ReactNode; description: string; label: string }) { return <div className="flex min-h-[74px] flex-col gap-3 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><div className="mt-1 text-xs text-[var(--app-muted)]">{description}</div></div><div className="flex w-full justify-end sm:w-[348px]">{children}</div></div> }
function translateError(error: string, t: (source: string) => string) { if (error.includes('PROVIDER_API_KEY_REQUIRED')) return t('该向量服务需要 API Key'); if (error.includes('PROVIDER_BASE_URL_REQUIRED')) return t('请填写向量 API 地址'); if (error.includes('INVALID')) return t('请检查模型 ID、协议和向量维度'); return error }

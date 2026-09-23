'use client'

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments } from '@/components/ai-elements/attachments'
import { AgentPromptTextarea, type AgentPromptSuggestion } from '@/components/agent-prompt-textarea'
import {
  ModelSelector,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorName,
  ModelSelectorLogo,
} from '@/components/ai-elements/model-selector'
import { PromptAddMenu } from '@/components/prompt-add-menu'
import { createChatSessionAction, deleteChatSessionAction } from '@/app/chat/actions'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ProjectSummary } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import { projectRuntimeDisplay } from '@/lib/project-runtime-display'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { AccessModePicker } from '@/components/access-mode-picker'
import { AgentKindPicker } from '@/components/agent-kind-picker'
import type { AccessMode } from '@/lib/chat-sessions'
import type { AgentKind } from '@/lib/chat-session-types'
import { useEffect, useState } from 'react'
import { BookOpenText, Code2, Plus, Send } from 'lucide-react'
import { serializePromptAttachments } from '@/lib/agent-runtime/serialize-prompt-attachments.client'

function WorkspacePromptAttachments() {
  const t = useT()
  const attachments = usePromptInputAttachments()
  if (!attachments.files.length) return null
  return <Attachments className="w-full px-3 pt-2" variant="inline">
    {attachments.files.map((file) => <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
      <AttachmentPreview />
      <AttachmentInfo />
      <AttachmentRemove label={t('移除 {filename}', { filename: file.filename ?? t('附件') })} />
    </Attachment>)}
  </Attachments>
}

export interface WorkspacePromptProps {
  configuredModels: ConfiguredModelOption[]
  defaultProject: ProjectSummary
  initialPrompt: string
  initialProjectId?: string
  projects: ProjectSummary[]
  workspaceSlug: string
  /**
   * Optional extra controls rendered in the composer footer (e.g. voice
   * input on the marketing page). Left unset for the in-app workspace so the
   * app composer stays the canonical surface.
   */
  renderExtraTools?: ReactNode
  /** Invoked when the session is created without an authenticated user. */
  onUnauthenticated?: () => void
  /** Optional controlled input. When set, the textarea is controlled; the
   * in-app usage omits it and keeps the internal state. */
  value?: string
  onValueChange?: (value: string) => void
}

/**
 * OpenLink's canonical project composer. Used verbatim by the in-app
 * workspace and reused by the marketing page — this is the single source of
 * truth for the prompt input (model + project selection + submit).
 */
export function WorkspacePrompt({
  configuredModels,
  defaultProject,
  initialPrompt,
  initialProjectId,
  projects,
  workspaceSlug,
  renderExtraTools,
  onUnauthenticated,
  value,
  onValueChange,
}: WorkspacePromptProps) {
  const router = useRouter()
  const t = useT()
  const [internalInput, setInternalInput] = useState(initialPrompt)
  const isControlled = typeof value !== 'undefined'
  const input = isControlled ? (value ?? '') : internalInput
  const updateInput = (next: string) => {
    if (isControlled) onValueChange?.(next)
    else setInternalInput(next)
  }
  const initialModel = configuredModels.find((model) => model.isDefault) ?? configuredModels[0] ?? null
  const [selectedModelId, setSelectedModelId] = useState(initialModel?.id ?? '')
  const selectedModel = configuredModels.find((model) => model.id === selectedModelId) ?? initialModel
  const modelGroups = configuredModels.reduce<Map<string, ConfiguredModelOption[]>>((groups, model) => {
    const providerModels = groups.get(model.providerName) ?? []
    providerModels.push(model)
    groups.set(model.providerName, providerModels)
    return groups
  }, new Map())
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false)
  const selectableProjects = projects.filter((project) => !project.is_default)
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(
    selectableProjects.find((project) => project.id === initialProjectId) ?? null,
  )
  useEffect(() => {
    setSelectedProject((current) => current
      ? projects.find((project) => !project.is_default && project.id === current.id) ?? null
      : current)
  }, [projects])
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<AccessMode>('restricted')
  const [agentKind, setAgentKind] = useState<AgentKind>('codex')
  const runtimeProject = selectedProject ?? defaultProject
  const runtimeDisplay = projectRuntimeDisplay(runtimeProject, t)
  const runtimeReady = runtimeDisplay.ready
  useEffect(() => {
    if (runtimeReady || runtimeProject.status === 'archived') return

    // The Project VM is provisioned out of band. Server-component props are a
    // snapshot, so keep the home composer in sync until the runtime reaches a
    // terminal/usable state instead of leaving a stale "initializing" screen.
    const refresh = () => router.refresh()
    const interval = window.setInterval(refresh, 2_500)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [router, runtimeProject.id, runtimeProject.status, runtimeReady])
  // Agent resources are session-scoped. Before a session exists there is no
  // runtime protocol to expose, so the home composer intentionally has none.
  const promptSuggestions: AgentPromptSuggestion[] = []

  return (
    <div className="flex w-full max-w-[700px] flex-col">
      <div className="flex h-[22px] items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold tracking-[-0.2px] text-[var(--app-foreground)]">Zorker</span>
          <AgentKindPicker value={agentKind} onChange={setAgentKind} />
        </div>
        <div aria-label={t('运行环境')} className="flex items-center gap-px rounded-full bg-[var(--app-subtle-surface)] p-px text-[13px]">
          <button aria-disabled className="rounded-full px-3 py-1 text-[var(--app-muted)]" disabled type="button" title={t('Cloud 即将推出')}>{t('Cloud')}</button>
          <span aria-current="true" className="rounded-full border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 py-1 text-[var(--app-foreground)] shadow-[0_1px_2px_var(--app-shadow)]">{t('Local')}</span>
        </div>
      </div>
    <PromptInput
      className="mt-3 w-full max-w-[700px] [&>[data-slot=input-group]]:h-[122px] [&>[data-slot=input-group]]:min-h-[122px] [&>[data-slot=input-group]]:overflow-visible! [&>[data-slot=input-group]]:rounded-[20px] [&>[data-slot=input-group]]:border-[var(--app-control-border)] [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:focus-within:border-[var(--app-focus-ring)] [&>[data-slot=input-group]]:focus-within:ring-0"
      accept={undefined}
      multiple
      onError={() => setSubmitError(t('无法添加文件，请检查文件数量和大小'))}
      onSubmit={async ({ text, files }) => {
        const prompt = text.trim()
        if (!prompt && !files.length) return
        if (!runtimeReady) {
          setSubmitError(`${runtimeDisplay.label}：${runtimeDisplay.detail}`)
          return
        }
        setSubmitError(null)
        const result = await createChatSessionAction({
          prompt,
          workspaceSlug,
          projectId: selectedProject?.id ?? null,
          providerId: selectedModel?.providerId,
          modelId: selectedModel?.modelId,
          accessMode: accessMode,
          agent: agentKind,
          autoStart: files.length === 0,
        })
        if (onUnauthenticated && 'error' in result && result.error === 'AUTH_REQUIRED') {
          onUnauthenticated()
          return
        }
        if (!result.id || !result.path) {
          const message = 'error' in result ? result.error : 'CHAT_SESSION_CREATE_FAILED'
          setSubmitError(message)
          throw new Error(message)
        }
        if (files.length) {
          try {
            const attachments = await serializePromptAttachments(result.id, files)
            const response = await fetch(`/api/chat/${encodeURIComponent(result.id)}/queue`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: crypto.randomUUID(),
                message: prompt,
                attachments,
                model: selectedModel ? { providerId: selectedModel.providerId, modelId: selectedModel.modelId } : null,
              }),
            })
            if (!response.ok) throw new Error(t('附件消息加入队列失败，请重试'))
          } catch (error) {
            await deleteChatSessionAction(result.id)
            const message = error instanceof Error ? error.message : t('文件上传失败，请重试')
            setSubmitError(message)
            throw error
          }
        }
        router.push(result.path)
      }}
    >
      <PromptInputBody className="relative flex w-full min-w-0 flex-1 flex-col">
        <WorkspacePromptAttachments />
        <AgentPromptTextarea
          aria-label={t('描述你想创建的内容')}
          className="min-h-[64px]! px-4 pt-4 text-[14px] leading-5 text-[var(--app-foreground)] placeholder:text-[var(--app-subtle-foreground)]"
          onValueChange={updateInput}
          disabled={!runtimeReady}
          placeholder=""
          suggestions={promptSuggestions}
          value={input}
          wrapperClassName="w-full self-stretch"
        />
      </PromptInputBody>
      <PromptInputFooter className="h-10 px-3 pb-3">
        <PromptInputTools className="min-w-0 flex-1 gap-0.5 overflow-hidden">
          <PromptAddMenu variant="home" agent={agentKind} attachmentsEnabled />
          <AccessModePicker value={accessMode} onChange={setAccessMode} />
          <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
            <ModelSelectorTrigger
              render={
                <PromptInputButton
                  aria-label={t('选择模型，当前 {name}', { name: selectedModel?.name ?? t('未配置') })}
                  className="-ml-0.5 h-7 min-w-0 max-w-[220px] shrink gap-1 overflow-hidden rounded-full px-2 text-[13px] font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]"
                  title={selectedModel?.name ?? t('配置模型')}
                  type="button"
                />
              }
            >
              {selectedModel && <ModelSelectorLogo className="size-4 shrink-0" provider={selectedModel.logo} />}
              <span className="min-w-0 truncate">{selectedModel?.name ?? t('配置模型')}</span>
              <img alt="" className="app-control-icon size-4 shrink-0" src="/openlink/app/prompt-chevron.svg" />
            </ModelSelectorTrigger>
            <ModelSelectorContent className="w-[320px]" title={t('选择模型')}>
              <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder={t('搜索模型')} />
              <ModelSelectorList className="max-h-64 p-1">
                <ModelSelectorEmpty className="text-muted-foreground">{t('没有已启用的模型')}</ModelSelectorEmpty>
                {[...modelGroups.entries()].map(([providerName, providerModels]) => (
                  <ModelSelectorGroup heading={providerName} key={providerName}>
                    {providerModels.map((model) => (
                      <ModelSelectorItem
                        className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                        key={model.id}
                        onSelect={() => {
                          setSelectedModelId(model.id)
                          setModelSelectorOpen(false)
                        }}
                        value={`${model.name} ${model.providerName} ${model.modelId}`}
                      >
                        <ModelSelectorLogo className="size-4" provider={model.logo} />
                        <ModelSelectorName>{model.name}</ModelSelectorName>
                        {model.isDefault && <span className="text-[11px] text-[var(--app-subtle-foreground)]">{t('默认')}</span>}
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorGroup>
                ))}
                <ModelSelectorGroup heading={t('管理')}>
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setModelSelectorOpen(false)
                      router.push('/settings/ai-providers')
                    }}
                    value={t('配置 AI 服务商')}
                  >
                    <Plus className="size-4" />
                    <ModelSelectorName>{t('配置 AI 服务商')}</ModelSelectorName>
                  </ModelSelectorItem>
                </ModelSelectorGroup>
              </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
          {renderExtraTools}
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <PromptInputSubmit aria-label={t('发送')} className="size-7 rounded-full border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 text-[var(--app-submit-foreground)] hover:bg-[var(--app-submit-hover)] disabled:cursor-wait disabled:opacity-40" disabled={!runtimeReady}>
            <Send aria-hidden className="size-3.5" />
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
      <div className="flex h-9 items-center gap-3 px-4 pt-3">
        <ModelSelector onOpenChange={setProjectSelectorOpen} open={projectSelectorOpen}>
          <ModelSelectorTrigger
            render={
              <button aria-label={t('选择项目，当前 {name}', { name: selectedProject?.name ?? t('默认 Draft 项目') })} className="-ml-1.5 flex h-5 items-center gap-1 rounded-md px-1.5 text-xs text-[var(--app-muted)] hover:bg-[var(--app-hover)]" type="button" />
            }
          >
            {selectedProject?.kind === 'research' ? <BookOpenText className="size-4" /> : <Code2 className="size-4" />}
            <span>{selectedProject?.name ?? t('Select Project')}</span>
          </ModelSelectorTrigger>
          <ModelSelectorContent className="w-[340px]" title={t('选择项目')}>
              <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder={t('搜索项目')} />
              <ModelSelectorList className="max-h-72 p-1">
                <ModelSelectorEmpty className="text-muted-foreground">{t('没有找到项目')}</ModelSelectorEmpty>
                <ModelSelectorGroup heading={t('工作项目')}>
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setSelectedProject(null)
                      setProjectSelectorOpen(false)
                    }}
                    value={t('无项目')}
                  >
                    <span className="flex size-4 items-center justify-center rounded-full border border-current" />
                    <ModelSelectorName>{t('无项目')}</ModelSelectorName>
                  </ModelSelectorItem>
                  {selectableProjects.map((project) => {
                    const Icon = project.kind === 'research' ? BookOpenText : Code2
                    const display = projectRuntimeDisplay(project, t)
                    const ready = display.ready
                    return (
                      <ModelSelectorItem
                        className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                        disabled={!ready}
                        key={project.id}
                        onSelect={() => {
                          setSelectedProject(project)
                          setProjectSelectorOpen(false)
                        }}
                        value={project.name}
                      >
                        <Icon className="size-4" />
                        <ModelSelectorName>{project.name}</ModelSelectorName>
                        <span className="max-w-[170px] truncate text-xs text-[var(--app-subtle-foreground)]" title={display.detail}>{ready ? (project.kind === 'research' ? t('研究') : t('代码')) : display.label}</span>
                      </ModelSelectorItem>
                    )
                  })}
                </ModelSelectorGroup>
                <ModelSelectorGroup heading={t('管理')}>
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setProjectSelectorOpen(false)
                      router.push(`/app/${workspaceSlug}/projects`)
                    }}
                    value={t('创建或管理项目')}
                  >
                    <Plus className="size-4" />
                    <ModelSelectorName>{t('创建或管理项目')}</ModelSelectorName>
                  </ModelSelectorItem>
                </ModelSelectorGroup>
              </ModelSelectorList>
          </ModelSelectorContent>
        </ModelSelector>
      </div>
      {submitError && <p className="px-4 text-xs text-destructive" role="alert">{submitError}</p>}
    </div>
  )
}

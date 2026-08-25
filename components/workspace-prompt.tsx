'use client'

import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input'
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
import { createChatSessionAction } from '@/app/chat/actions'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ProjectSummary } from '@/lib/projects'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { AccessModePicker } from '@/components/access-mode-picker'
import type { AccessMode } from '@/lib/chat-sessions'
import { useState } from 'react'
import { BookOpenText, Code2, Plus, Send } from 'lucide-react'

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
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<AccessMode>('restricted')
  const runtimeProject = selectedProject ?? defaultProject
  const runtimeReady = runtimeProject.status === 'active' && runtimeProject.runtime_status === 'ready'

  return (
    <div className="flex w-full max-w-[700px] flex-col">
      <div className="flex h-[22px] items-center justify-between px-4">
        <span className="text-sm font-bold tracking-[-0.2px] text-[var(--app-foreground)]">Zorker</span>
        <div aria-label="运行环境" className="flex items-center gap-px rounded-full bg-[var(--app-subtle-surface)] p-px text-[13px]">
          <button aria-disabled className="rounded-full px-3 py-1 text-[var(--app-muted)]" disabled title="Cloud 即将推出" type="button">Cloud</button>
          <span aria-current="true" className="rounded-full border border-[var(--app-control-border)] bg-[var(--app-surface)] px-3 py-1 text-[var(--app-foreground)] shadow-[0_1px_2px_var(--app-shadow)]">Local</span>
        </div>
      </div>
    <PromptInput
      className="mt-3 w-full max-w-[700px] [&>[data-slot=input-group]]:h-[122px] [&>[data-slot=input-group]]:min-h-[122px] [&>[data-slot=input-group]]:rounded-[20px] [&>[data-slot=input-group]]:border-[var(--app-control-border)] [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:focus-within:border-[var(--app-focus-ring)] [&>[data-slot=input-group]]:focus-within:ring-0"
      onSubmit={async ({ text }) => {
        const prompt = text.trim()
        if (!prompt) return
        if (!runtimeReady) {
          setSubmitError('项目环境仍在初始化，完成后即可创建对话。')
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
        })
        if (onUnauthenticated && 'error' in result && result.error === 'AUTH_REQUIRED') {
          onUnauthenticated()
          return
        }
        if (result.path) router.push(result.path)
      }}
    >
      <PromptInputBody>
        <PromptInputTextarea
          aria-label="描述你想创建的内容"
          className="min-h-[64px]! px-4 pt-4 text-[14px] leading-5 text-[var(--app-foreground)] placeholder:text-[var(--app-subtle-foreground)]"
          onChange={(event) => updateInput(event.currentTarget.value)}
          disabled={!runtimeReady}
          placeholder={runtimeReady ? '描述你想构建的内容，或向 OpenLink 提问' : '项目环境正在初始化…'}
          value={input}
        />
      </PromptInputBody>
      <PromptInputFooter className="h-10 px-3 pb-3">
        <PromptInputTools className="gap-0.5">
          <PromptAddMenu variant="home" />
          <AccessModePicker value={accessMode} onChange={setAccessMode} />
          <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
            <ModelSelectorTrigger
              render={
                <PromptInputButton className="h-7 max-w-[220px] gap-1 rounded-full px-2 text-[13px] font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" type="button" />
              }
            >
              {selectedModel && <ModelSelectorLogo className="size-4" provider={selectedModel.logo} />}
              <span>{selectedModel?.name ?? '配置模型'}</span>
              <img alt="" className="app-control-icon size-4" src="/openlink/app/prompt-chevron.svg" />
            </ModelSelectorTrigger>
            <ModelSelectorContent className="w-[320px]" title="选择模型">
              <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder="搜索模型" />
              <ModelSelectorList className="max-h-64 p-1">
                <ModelSelectorEmpty className="text-muted-foreground">没有已启用的模型</ModelSelectorEmpty>
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
                        {model.isDefault && <span className="text-[11px] text-[var(--app-subtle-foreground)]">默认</span>}
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorGroup>
                ))}
                <ModelSelectorGroup heading="管理">
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setModelSelectorOpen(false)
                      router.push('/settings/ai-providers')
                    }}
                    value="配置 AI 服务商"
                  >
                    <Plus className="size-4" />
                    <ModelSelectorName>配置 AI 服务商</ModelSelectorName>
                  </ModelSelectorItem>
                </ModelSelectorGroup>
              </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
          {renderExtraTools}
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <PromptInputSubmit aria-label="发送" className="size-7 rounded-full border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 text-[var(--app-submit-foreground)] hover:bg-[var(--app-submit-hover)] disabled:cursor-wait disabled:opacity-40" disabled={!runtimeReady}>
            <Send aria-hidden className="size-3.5" />
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
      <div className="flex h-9 items-center gap-3 px-4 pt-3">
        <ModelSelector onOpenChange={setProjectSelectorOpen} open={projectSelectorOpen}>
          <ModelSelectorTrigger
            render={
              <button aria-label={`选择项目，当前 ${selectedProject?.name ?? '默认 Draft 项目'}`} className="-ml-1.5 flex h-5 items-center gap-1 rounded-md px-1.5 text-xs text-[var(--app-muted)] hover:bg-[var(--app-hover)]" type="button" />
            }
          >
            {selectedProject?.kind === 'research' ? <BookOpenText className="size-4" /> : <Code2 className="size-4" />}
            <span>{selectedProject?.name ?? 'Select Project'}</span>
          </ModelSelectorTrigger>
          <ModelSelectorContent className="w-[340px]" title="选择项目">
              <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder="搜索项目" />
              <ModelSelectorList className="max-h-72 p-1">
                <ModelSelectorEmpty className="text-muted-foreground">没有找到项目</ModelSelectorEmpty>
                <ModelSelectorGroup heading="工作项目">
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setSelectedProject(null)
                      setProjectSelectorOpen(false)
                    }}
                    value="无项目"
                  >
                    <span className="flex size-4 items-center justify-center rounded-full border border-current" />
                    <ModelSelectorName>无项目</ModelSelectorName>
                  </ModelSelectorItem>
                  {selectableProjects.map((project) => {
                    const Icon = project.kind === 'research' ? BookOpenText : Code2
                    const ready = project.status === 'active' && project.runtime_status === 'ready'
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
                        <span className="text-xs text-[var(--app-subtle-foreground)]">{ready ? (project.kind === 'research' ? '研究' : '代码') : '等待初始化'}</span>
                      </ModelSelectorItem>
                    )
                  })}
                </ModelSelectorGroup>
                <ModelSelectorGroup heading="管理">
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setProjectSelectorOpen(false)
                      router.push(`/app/${workspaceSlug}/projects`)
                    }}
                    value="创建或管理项目"
                  >
                    <Plus className="size-4" />
                    <ModelSelectorName>创建或管理项目</ModelSelectorName>
                  </ModelSelectorItem>
                </ModelSelectorGroup>
              </ModelSelectorList>
          </ModelSelectorContent>
        </ModelSelector>
      </div>
      {!runtimeReady && <p className="px-4 text-xs text-[var(--app-muted)]">{runtimeProject.name} 正在初始化 VM，项目进入活动状态后才能创建对话。</p>}
      {submitError && <p className="px-4 text-xs text-destructive" role="alert">{submitError}</p>}
    </div>
  )
}

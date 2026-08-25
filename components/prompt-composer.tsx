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
import { SpeechInput } from '@/components/ai-elements/speech-input'
import { createChatSessionAction } from '@/app/chat/actions'
import { theme } from '@/lib/theme'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { ProjectSummary } from '@/lib/projects'
import type { ComposerContext, ComposerWorkspace } from '@/lib/composer-context'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { BookOpenText, Code2, Plus, Send } from 'lucide-react'

export type { ComposerContext, ComposerWorkspace } from '@/lib/composer-context'

interface PromptComposerProps {
  user: { email: string | null; name: string | null } | null
  composerContext: ComposerContext | null
}

function selectableProjects(workspace: ComposerWorkspace | undefined): ProjectSummary[] {
  return workspace?.projects ?? []
}

export function PromptComposer({ user, composerContext }: PromptComposerProps) {
  const router = useRouter()
  const [input, setInput] = useState('')
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = useState<string>(composerContext?.workspaces[0]?.slug ?? '')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedModelId, setSelectedModelId] = useState<string>(composerContext?.models.find((model) => model.isDefault)?.id ?? composerContext?.models[0]?.id ?? '')
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false)
  const [workspaceSelectorOpen, setWorkspaceSelectorOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const workspaces = composerContext?.workspaces ?? []
  const models = composerContext?.models ?? []
  const workspace = workspaces.find((candidate) => candidate.slug === selectedWorkspaceSlug) ?? workspaces[0]
  const projects = selectableProjects(workspace)
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null
  const runtimeProject = selectedProject ?? workspace?.defaultProject
  const runtimeReady = Boolean(runtimeProject && runtimeProject.status === 'active' && runtimeProject.runtime_status === 'ready')
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models.find((model) => model.isDefault) ?? models[0] ?? null

  const modelGroups = useMemo(() => {
    const groups = new Map<string, ConfiguredModelOption[]>()
    for (const model of models) {
      const providerModels = groups.get(model.providerName) ?? []
      providerModels.push(model)
      groups.set(model.providerName, providerModels)
    }
    return groups
  }, [models])

  const handleSubmit = async () => {
    const prompt = input.trim()
    if (!prompt) return
    // Signed-out users are sent to the login/register gate and complete the
    // flow there; the prompt is carried so they can continue after signing in.
    if (!user) {
      router.push(`/login?next=${encodeURIComponent(`/app?prompt=${encodeURIComponent(prompt)}`)}`)
      return
    }
    if (!workspace) {
      setSubmitError('没有可用的 workspace。')
      return
    }
    if (!runtimeReady) {
      setSubmitError('项目环境仍在初始化，完成后即可创建对话。')
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    try {
      const result = await createChatSessionAction({
        prompt,
        workspaceSlug: workspace.slug,
        projectId: selectedProjectId ?? null,
        providerId: selectedModel?.providerId,
        modelId: selectedModel?.modelId,
      })
      if (result.path) router.push(result.path)
      else if (result.error) setSubmitError(result.error)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '创建会话失败')
    } finally {
      setSubmitting(false)
    }
  }

  const switchWorkspace = (slug: string) => {
    setSelectedWorkspaceSlug(slug)
    setSelectedProjectId(null)
    setWorkspaceSelectorOpen(false)
  }

  return (
    <div className="mx-auto w-full max-w-[690px]">
      <PromptInput
        className="[&>[data-slot=input-group]]:min-h-[108px] [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:border-[var(--app-control-border)] [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:focus-within:border-[var(--app-focus-ring)] [&>[data-slot=input-group]]:focus-within:ring-0"
        onSubmit={handleSubmit}
      >
        <PromptInputBody>
          <PromptInputTextarea
            aria-label="描述您想创建的内容"
            className="min-h-[54px]! px-3 pt-3 text-[15px] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle-foreground)]"
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder=""
            value={input}
          />
        </PromptInputBody>
        <PromptInputFooter className="h-10 px-3 pb-3">
          <PromptInputTools className="gap-0.5">
            {workspaces.length > 1 && (
              <ModelSelector onOpenChange={setWorkspaceSelectorOpen} open={workspaceSelectorOpen}>
                <ModelSelectorTrigger
                  render={
                    <PromptInputButton className="h-7 max-w-[180px] gap-1 rounded-md px-1.5 text-[13px] font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" type="button" />
                  }
                >
                  <span>{workspace?.name ?? '选择一个 workspace'}</span>
                </ModelSelectorTrigger>
                <ModelSelectorContent className="w-[260px]" title="选择 workspace">
                  <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder="搜索 workspace" />
                  <ModelSelectorList className="max-h-60 p-1">
                    {workspaces.map((candidate) => (
                      <ModelSelectorItem
                        className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                        key={candidate.id}
                        onSelect={() => switchWorkspace(candidate.slug)}
                        value={candidate.name}
                      >
                        <span className="flex size-4 items-center justify-center rounded-full border border-current" />
                        <ModelSelectorName>{candidate.name}</ModelSelectorName>
                        <span className="text-xs text-[var(--app-subtle-foreground)]">{candidate.scopeType === 'organization' ? '组织' : '个人'}</span>
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorList>
                </ModelSelectorContent>
              </ModelSelector>
            )}
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
                <ModelSelectorList className="max-h-60 p-1">
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
            <SpeechInput
              aria-label="开始语音输入"
              className={`size-7 rounded-full border border-[var(--app-control-border)] text-[var(--app-muted)] hover:text-[var(--app-foreground)] ${theme('surface', 'hover')}`}
              lang="zh-CN"
              onTranscriptionChange={(text) => setInput(text)}
              type="button"
            />
          </PromptInputTools>
          <div className="flex items-center gap-1">
            <PromptInputSubmit
              aria-label="发送"
              className="size-7 rounded-full border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 text-[var(--app-submit-foreground)] hover:bg-[var(--app-submit-hover)] disabled:cursor-wait disabled:opacity-40"
              disabled={submitting || (user ? !runtimeReady : false)}
            >
              <Send aria-hidden className="size-3.5" />
            </PromptInputSubmit>
          </div>
        </PromptInputFooter>
      </PromptInput>
      {workspace && (
        <div className="mt-2 px-1">
          <ModelSelector onOpenChange={setProjectSelectorOpen} open={projectSelectorOpen}>
            <ModelSelectorTrigger
              render={
                <button aria-label={`选择项目，当前 ${selectedProject?.name ?? '默认 Draft 项目'}`} className="-ml-1.5 flex h-5 items-center gap-1 rounded-md px-1.5 text-xs text-[var(--app-muted)] hover:bg-[var(--app-hover)]" type="button" />
              }
            >
              {selectedProject?.kind === 'research' ? <BookOpenText className="size-3.5" /> : <Code2 className="size-3.5" />}
              <span>{selectedProject?.name ?? '默认 Draft 项目'}</span>
            </ModelSelectorTrigger>
            <ModelSelectorContent className="w-[340px]" title="选择项目">
              <ModelSelectorInput className="border-0 bg-transparent text-foreground placeholder:text-muted-foreground" placeholder="搜索项目" />
              <ModelSelectorList className="max-h-64 p-1">
                <ModelSelectorEmpty className="text-muted-foreground">没有找到项目</ModelSelectorEmpty>
                <ModelSelectorGroup heading="工作项目">
                  <ModelSelectorItem
                    className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    onSelect={() => {
                      setSelectedProjectId(null)
                      setProjectSelectorOpen(false)
                    }}
                    value="默认 Draft"
                  >
                    <span className="flex size-4 items-center justify-center rounded-full border border-current" />
                    <ModelSelectorName>默认 Draft 项目</ModelSelectorName>
                  </ModelSelectorItem>
                  {projects.map((project) => {
                    const Icon = project.kind === 'research' ? BookOpenText : Code2
                    const ready = project.status === 'active' && project.runtime_status === 'ready'
                    return (
                      <ModelSelectorItem
                        className="h-9 text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                        disabled={!ready}
                        key={project.id}
                        onSelect={() => {
                          setSelectedProjectId(project.id)
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
                      router.push(`/app/${workspace.slug}/projects`)
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
      )}
      {submitError && <p className="mt-2 px-1 text-xs text-[var(--app-danger)]" role="alert">{submitError}</p>}
    </div>
  )
}

'use client'

import { createProjectAction } from '@/app/app/project-actions'
import {
  FeatureDialog,
  FeatureDialogBody,
  FeatureDialogContent,
  FeatureDialogHeader,
  FeatureDialogTitle,
} from '@/components/ui/feature-dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ProjectKind, ProjectSourceType, ProjectSummary } from '@/lib/projects'
import {
  ArrowLeft,
  BookOpenText,
  CirclePlus,
  Code2,
  GitBranch,
  Loader2,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

type ProjectCreationMode = 'blank-code' | 'github' | 'research'

interface NewProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ProjectSummary[]
  workspaceSlug: string
}

const creationOptions: Array<{
  mode: ProjectCreationMode
  label: string
  icon: typeof CirclePlus
}> = [
  { mode: 'blank-code', label: 'Blank Project', icon: CirclePlus },
  { mode: 'github', label: 'Import from GitHub', icon: GitBranch },
  { mode: 'research', label: 'Research Project', icon: BookOpenText },
]

function ProjectKindIcon({ kind, className = 'size-4' }: { kind: ProjectKind; className?: string }) {
  const Icon = kind === 'research' ? BookOpenText : Code2
  return <Icon aria-hidden className={className} />
}

function creationDetails(mode: ProjectCreationMode) {
  if (mode === 'github') {
    return {
      title: 'Import from GitHub',
      kind: 'code' as const,
      sourceType: 'github' as const,
      description: 'Connect a repository and use it as the project workspace.',
    }
  }
  if (mode === 'research') {
    return {
      title: 'New Research Project',
      kind: 'research' as const,
      sourceType: 'blank' as const,
      description: 'Create a workspace for papers, sources, notes, and experiments.',
    }
  }
  return {
    title: 'New Blank Project',
    kind: 'code' as const,
    sourceType: 'blank' as const,
    description: 'Start an empty code project for a website, app, or service.',
  }
}

export function NewProjectDialog({
  open,
  onOpenChange,
  projects,
  workspaceSlug,
}: NewProjectDialogProps) {
  const router = useRouter()
  const [mode, setMode] = useState<ProjectCreationMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isPending) return
    onOpenChange(nextOpen)
    if (!nextOpen) {
      setMode(null)
      setError(null)
    }
  }

  const details = mode ? creationDetails(mode) : null

  return (
    <FeatureDialog onOpenChange={handleOpenChange} open={open}>
      <FeatureDialogContent
        className="min-h-[477px] w-[min(600px,calc(100vw-32px))] rounded-xl border-[var(--app-control-border)] bg-[var(--app-background)] shadow-[0_28px_80px_var(--app-shadow)] sm:max-w-none"
        showCloseButton={false}
      >
        {!mode ? (
          <>
            <FeatureDialogHeader className="border-b-0 px-6 pb-5 pt-6">
              <FeatureDialogTitle className="text-xl leading-[26px] tracking-[-0.45px]">New Project</FeatureDialogTitle>
            </FeatureDialogHeader>
            <FeatureDialogBody className="px-6 pb-6 pt-0">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {creationOptions.map(({ mode: optionMode, label, icon: Icon }) => (
                  <button
                    className="group flex h-[95px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-background)] text-[var(--app-muted)] hover:border-[var(--app-focus-ring)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]"
                    key={optionMode}
                    onClick={() => {
                      setMode(optionMode)
                      setError(null)
                    }}
                    type="button"
                  >
                    <Icon aria-hidden className="size-6" strokeWidth={1.9} />
                    <span className="text-sm leading-5 tracking-[-0.1504px]">{label}</span>
                  </button>
                ))}
              </div>

              <section className="mt-8">
                <h3 className="text-sm font-normal leading-5 tracking-[-0.1504px] text-[var(--app-muted)]">Jump back in</h3>
                <div className="mt-3 flex min-h-[220px] flex-col">
                  {projects.length ? projects.slice(0, 5).map((project) => (
                    <button
                      className="-mx-2 flex h-11 items-center gap-3 rounded-md px-2 text-left hover:bg-[var(--app-surface)]"
                      key={project.id}
                      onClick={() => {
                        handleOpenChange(false)
                        router.push(`/app/${workspaceSlug}?project=${project.id}`)
                      }}
                      type="button"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--app-control-border)] text-[var(--app-muted)]">
                        <ProjectKindIcon className="size-3.5" kind={project.kind} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-foreground)]">{project.name}</span>
                      <span className="text-xs text-[var(--app-subtle)]">{project.kind === 'research' ? 'Research' : 'Code'}</span>
                    </button>
                  )) : (
                    <div className="flex min-h-[176px] items-center justify-center rounded-lg border border-dashed border-[var(--app-control-border)] text-sm text-[var(--app-subtle)]">
                      No projects yet
                    </div>
                  )}
                </div>
              </section>
            </FeatureDialogBody>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const formData = new FormData(event.currentTarget)
              const name = String(formData.get('name') ?? '')
              const sourceUrl = String(formData.get('sourceUrl') ?? '')
              const description = String(formData.get('description') ?? '')
              const kind: ProjectKind = details?.kind ?? 'code'
              const sourceType: ProjectSourceType = details?.sourceType ?? 'blank'

              setError(null)
              startTransition(async () => {
                const result = await createProjectAction({
                  workspaceSlug,
                  name,
                  kind,
                  sourceType,
                  sourceUrl,
                  description,
                })
                if (result.error) {
                  setError(result.error)
                  return
                }
                handleOpenChange(false)
                router.refresh()
              })
            }}
          >
            <FeatureDialogHeader className="border-b-0 px-6 pb-4 pt-6">
              <button
                aria-label="返回项目类型"
                className="mb-3 flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]"
                onClick={() => {
                  setMode(null)
                  setError(null)
                }}
                type="button"
              >
                <ArrowLeft className="size-4" />
              </button>
              <FeatureDialogTitle className="text-xl leading-[26px] tracking-[-0.45px]">{details?.title}</FeatureDialogTitle>
              <p className="max-w-[470px] text-sm leading-5 text-[var(--app-muted)]">{details?.description}</p>
            </FeatureDialogHeader>
            <FeatureDialogBody className="space-y-5 px-6 pb-6 pt-2">
              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--app-foreground)]">Project name</span>
                <Input
                  autoFocus
                  className="h-9 rounded-md border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle)] focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
                  maxLength={100}
                  name="name"
                  placeholder={mode === 'research' ? 'Research topic' : 'my-project'}
                  required
                />
              </label>

              {mode === 'github' && (
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--app-foreground)]">GitHub repository</span>
                  <Input
                    className="h-9 rounded-md border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle)] focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
                    name="sourceUrl"
                    placeholder="https://github.com/owner/repository"
                    required
                    type="url"
                  />
                </label>
              )}

              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--app-foreground)]">Description <span className="font-normal text-[var(--app-subtle)]">Optional</span></span>
                <Textarea
                  className="min-h-[82px] resize-none rounded-md border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle)] focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
                  maxLength={2000}
                  name="description"
                  placeholder={mode === 'research' ? 'What question are you investigating?' : 'What are you building?'}
                />
              </label>

              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  className="h-8 rounded-md px-3 text-sm font-medium text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]"
                  disabled={isPending}
                  onClick={() => handleOpenChange(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="flex h-8 min-w-[84px] items-center justify-center gap-2 rounded-md bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:opacity-90 disabled:opacity-50"
                  disabled={isPending}
                  type="submit"
                >
                  {isPending && <Loader2 className="size-4 animate-spin" />}
                  Create
                </button>
              </div>
            </FeatureDialogBody>
          </form>
        )}
      </FeatureDialogContent>
    </FeatureDialog>
  )
}

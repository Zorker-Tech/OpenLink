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
import type { ProjectDiskMode, ProjectExecutionMode, ProjectKind, ProjectSourceType, ProjectSummary } from '@/lib/projects'
import {
  ArrowLeft,
  BookOpenText,
  CirclePlus,
  Code2,
  GitBranch,
  HardDrive,
  Layers3,
  Loader2,
  MonitorCog,
  Network,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
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

function creationDetails(mode: ProjectCreationMode, t: Translator) {
  if (mode === 'github') {
    return {
      title: t('Import from GitHub'),
      kind: 'code' as const,
      sourceType: 'github' as const,
      description: t('Connect a repository and use it as the project workspace.'),
    }
  }
  if (mode === 'research') {
    return {
      title: t('New Research Project'),
      kind: 'research' as const,
      sourceType: 'blank' as const,
      description: t('Create a workspace for papers, sources, notes, and experiments.'),
    }
  }
  return {
    title: t('New Blank Project'),
    kind: 'code' as const,
    sourceType: 'blank' as const,
    description: t('Start an empty code project for a website, app, or service.'),
  }
}

export function NewProjectDialog({
  open,
  onOpenChange,
  projects,
  workspaceSlug,
}: NewProjectDialogProps) {
  const t = useT()
  const router = useRouter()
  const [mode, setMode] = useState<ProjectCreationMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diskMode, setDiskMode] = useState<ProjectDiskMode>('thin')
  const [executionMode, setExecutionMode] = useState<ProjectExecutionMode>('local')
  const [isPending, startTransition] = useTransition()

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isPending) return
    onOpenChange(nextOpen)
    if (!nextOpen) {
      setMode(null)
      setError(null)
      setDiskMode('thin')
      setExecutionMode('local')
    }
  }

  const details = mode ? creationDetails(mode, t) : null

  return (
    <FeatureDialog onOpenChange={handleOpenChange} open={open}>
      <FeatureDialogContent
        className="min-h-[477px] w-[min(600px,calc(100vw-32px))] rounded-xl border-[var(--app-control-border)] bg-[var(--app-background)] shadow-[0_28px_80px_var(--app-shadow)] sm:max-w-none"
        showCloseButton={false}
      >
        {!mode ? (
          <>
            <FeatureDialogHeader className="border-b-0 px-6 pb-5 pt-6">
              <FeatureDialogTitle className="text-xl leading-[26px] tracking-[-0.45px]">{t('New Project')}</FeatureDialogTitle>
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
                      setDiskMode('thin')
                      setExecutionMode('local')
                    }}
                    type="button"
                  >
                    <Icon aria-hidden className="size-6" strokeWidth={1.9} />
                    <span className="text-sm leading-5 tracking-[-0.1504px]">{t(label)}</span>
                  </button>
                ))}
              </div>

              <section className="mt-8">
                <h3 className="text-sm font-normal leading-5 tracking-[-0.1504px] text-[var(--app-muted)]">{t('Jump back in')}</h3>
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
                      <span className="text-xs text-[var(--app-subtle-foreground)]">{project.kind === 'research' ? t('Research') : t('Code')}</span>
                    </button>
                  )) : (
                    <div className="flex min-h-[176px] items-center justify-center rounded-lg border border-dashed border-[var(--app-control-border)] text-sm text-[var(--app-subtle-foreground)]">
                      {t('No projects yet')}
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
                  diskMode,
                  executionMode,
                  sshTarget: executionMode === 'ssh' ? {
                    host: String(formData.get('sshHost') ?? ''),
                    port: Number(formData.get('sshPort') ?? 22),
                    user: String(formData.get('sshUser') ?? ''),
                    remoteRoot: String(formData.get('sshRemoteRoot') ?? ''),
                    privateKey: String(formData.get('sshPrivateKey') ?? ''),
                    knownHosts: String(formData.get('sshKnownHosts') ?? ''),
                  } : undefined,
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
                aria-label={t('返回项目类型')}
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
                <span className="text-sm font-medium text-[var(--app-foreground)]">{t('Project name')}</span>
                <Input
                  autoFocus
                  className="h-9 rounded-md border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
                  maxLength={100}
                  name="name"
                  placeholder={mode === 'research' ? t('Research topic') : t('my-project')}
                  required
                />
              </label>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-[var(--app-foreground)]">{t('执行环境')}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    aria-pressed={executionMode === 'local'}
                    className={`flex min-h-[72px] items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${executionMode === 'local' ? 'border-[var(--app-focus-ring)] bg-[var(--app-surface)]' : 'border-[var(--app-control-border)] bg-[var(--app-background)] hover:bg-[var(--app-surface)]'}`}
                    onClick={() => setExecutionMode('local')}
                    type="button"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-background)] text-[var(--app-muted)]"><MonitorCog aria-hidden className="size-3.5" /></span>
                    <span>
                      <span className="block text-sm font-medium text-[var(--app-foreground)]">{t('本地')}</span>
                      <span className="mt-1 block text-xs leading-4 text-[var(--app-muted)]">{t('在本机的 Project VM 中初始化与运行。')}</span>
                    </span>
                  </button>
                  <button
                    aria-pressed={executionMode === 'ssh'}
                    className={`flex min-h-[72px] items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${executionMode === 'ssh' ? 'border-[var(--app-focus-ring)] bg-[var(--app-surface)]' : 'border-[var(--app-control-border)] bg-[var(--app-background)] hover:bg-[var(--app-surface)]'}`}
                    onClick={() => setExecutionMode('ssh')}
                    type="button"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-background)] text-[var(--app-muted)]"><Network aria-hidden className="size-3.5" /></span>
                    <span>
                      <span className="block text-sm font-medium text-[var(--app-foreground)]">{t('远程 SSH')}</span>
                      <span className="mt-1 block text-xs leading-4 text-[var(--app-muted)]">{t('在目标 Linux 主机内创建该项目专属 VM。')}</span>
                    </span>
                  </button>
                </div>
              </fieldset>

              {executionMode === 'ssh' && (
                <fieldset className="space-y-3 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3">
                  <div>
                    <p className="text-sm font-medium text-[var(--app-foreground)]">{t('SSH 连接')}</p>
                    <p className="mt-1 text-xs leading-4 text-[var(--app-muted)]">{t('目标将永久绑定到此项目。私钥会以 AES-256-GCM 加密保存，且连接必须匹配你提供的主机密钥。')}</p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_104px]">
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-[var(--app-muted)]">{t('主机')}</span>
                      <Input name="sshHost" placeholder={t('192.168.1.20 或 server.example.com')} required />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-[var(--app-muted)]">{t('端口')}</span>
                      <Input defaultValue="22" max="65535" min="1" name="sshPort" required type="number" />
                    </label>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-[var(--app-muted)]">{t('用户')}</span>
                      <Input name="sshUser" placeholder={t('ubuntu')} required />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-[var(--app-muted)]">{t('远程根目录')}</span>
                      <Input defaultValue="/opt/openlink" name="sshRemoteRoot" required />
                    </label>
                  </div>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-[var(--app-muted)]">{t('私钥')}</span>
                    <Textarea className="min-h-[112px] resize-y font-mono text-xs" name="sshPrivateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" required />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-[var(--app-muted)]">{t('主机密钥（known_hosts）')}</span>
                    <Textarea className="min-h-[66px] resize-y font-mono text-xs" name="sshKnownHosts" placeholder="server.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI…" required />
                  </label>
                </fieldset>
              )}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-[var(--app-foreground)]">{t('Disk allocation')}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    aria-pressed={diskMode === 'thin'}
                    className={`flex min-h-[74px] items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${diskMode === 'thin' ? 'border-[var(--app-focus-ring)] bg-[var(--app-surface)]' : 'border-[var(--app-control-border)] bg-[var(--app-background)] hover:bg-[var(--app-surface)]'}`}
                    onClick={() => setDiskMode('thin')}
                    type="button"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-background)] text-[var(--app-muted)]">
                      <Layers3 aria-hidden className="size-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium text-[var(--app-foreground)]">
                        {t('Sparse')}
                        <span className="rounded-full bg-[var(--app-subtle-surface)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--app-muted)]">{t('Recommended')}</span>
                      </span>
                      <span className="mt-1 block text-xs leading-4 text-[var(--app-muted)]">{t('64 GB capacity. Host usage grows with project data.')}</span>
                    </span>
                  </button>
                  <button
                    aria-pressed={diskMode === 'thick'}
                    className={`flex min-h-[74px] items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${diskMode === 'thick' ? 'border-[var(--app-focus-ring)] bg-[var(--app-surface)]' : 'border-[var(--app-control-border)] bg-[var(--app-background)] hover:bg-[var(--app-surface)]'}`}
                    onClick={() => setDiskMode('thick')}
                    type="button"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-background)] text-[var(--app-muted)]">
                      <HardDrive aria-hidden className="size-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-[var(--app-foreground)]">{t('Fully allocated')}</span>
                      <span className="mt-1 block text-xs leading-4 text-[var(--app-muted)]">{t('Reserves the full 64 GB on the host immediately.')}</span>
                    </span>
                  </button>
                </div>
              </fieldset>

              {mode === 'github' && (
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-[var(--app-foreground)]">{t('GitHub repository')}</span>
                  <Input
                  className="h-9 rounded-md border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
                    name="sourceUrl"
                    placeholder="https://github.com/owner/repository"
                    required
                    type="url"
                  />
                </label>
              )}

              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--app-foreground)]">{t('Description')} <span className="font-normal text-[var(--app-subtle-foreground)]">{t('Optional')}</span></span>
                <Textarea
                  className="min-h-[82px] resize-none rounded-md border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
                  maxLength={2000}
                  name="description"
                  placeholder={mode === 'research' ? t('What question are you investigating?') : t('What are you building?')}
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
                  {t('Cancel')}
                </button>
                <button
                  className="flex h-8 min-w-[84px] items-center justify-center gap-2 rounded-md bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:opacity-90 disabled:opacity-50"
                  disabled={isPending}
                  type="submit"
                >
                  {isPending && <Loader2 className="size-4 animate-spin" />}
                  {isPending ? t('创建中…') : t('Create')}
                </button>
              </div>
            </FeatureDialogBody>
          </form>
        )}
      </FeatureDialogContent>
    </FeatureDialog>
  )
}

'use client'

import { Sidebar } from '@/components/app-workspace'
import { PageTransition } from '@/components/ui/page-transition'
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed'
import { NewProjectDialog } from '@/components/new-project-dialog'
import type { ThemeMode } from '@/components/account-drawer'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import type { ActiveWorkspaceSummary, PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import type { OrganizationSummary } from '@/lib/organizations'
import type { ProjectSummary } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { projectRuntimeDisplay } from '@/lib/project-runtime-display'
import {
  BookOpenText,
  Code2,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Search,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

interface ProjectsWorkspaceProps {
  activeWorkspace: ActiveWorkspaceSummary
  personalWorkspace: PersonalWorkspaceSummary
  organizations: OrganizationSummary[]
  projects: ProjectSummary[]
  nickname: string
  email: string
  avatarUrl: string | null
  canManageProjects: boolean
}

function relativeProjectTime(value: string, t: Translator) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime())
  const days = Math.floor(elapsed / 86_400_000)
  if (days > 0) return t('{days}d ago', { days })
  const hours = Math.floor(elapsed / 3_600_000)
  if (hours > 0) return t('{hours}h ago', { hours })
  return t('just now')
}

function ProjectCard({ project, workspaceSlug }: { project: ProjectSummary; workspaceSlug: string }) {
  const router = useRouter()
  const t = useT()
  const Icon = project.kind === 'research' ? BookOpenText : Code2
  const runtime = projectRuntimeDisplay(project, t)
  const ready = runtime.ready
  const failed = runtime.failed
  const activityLabel = ready ? t('活动 · {time}', { time: relativeProjectTime(project.updated_at, t) }) : `${runtime.label} · ${runtime.detail}`

  return (
    <article className="group min-w-0">
      <button
        aria-label={t('选择项目 {name}', { name: project.name })}
        className="relative flex aspect-[340/181] w-full items-center justify-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-elevated)] text-[var(--app-subtle-foreground)] enabled:hover:border-[var(--app-focus-ring)] enabled:hover:bg-[var(--app-surface)] enabled:hover:text-[var(--app-muted)] disabled:cursor-wait"
        disabled={!ready}
        onClick={() => router.push(`/app/${workspaceSlug}?project=${project.id}`)}
        type="button"
      >
        <Icon className="size-9 opacity-35 transition-opacity group-hover:opacity-70" strokeWidth={1.5} />
        {!ready && (
          <span className="absolute bottom-3 left-3 flex h-6 items-center gap-1.5 rounded-full border border-[var(--app-control-border)] bg-[var(--app-background)]/90 px-2 text-[11px] text-[var(--app-muted)] backdrop-blur">
            <LoaderCircle className={`size-3 ${runtime.spinning ? 'animate-spin' : ''}`} />
            <span className="max-w-[210px] truncate" title={`${runtime.label} · ${runtime.detail}`}>{runtime.label}</span>
          </span>
        )}
      </button>
      <div className="mt-2 grid grid-cols-[32px_minmax(0,1fr)_28px] grid-rows-[20px_16px] gap-x-3 gap-y-1">
        <span className="row-span-2 flex size-8 items-center justify-center self-center rounded-full border border-[var(--app-control-border)] bg-[var(--app-background)] text-[var(--app-foreground)]">
          {project.source_type === 'github'
            ? <GitBranch className="size-3.5" />
            : <Icon className="size-3.5" />}
        </span>
        <button
          className="min-w-0 truncate text-left text-sm font-medium leading-5 tracking-[-0.1504px] text-[var(--app-foreground)] hover:underline"
          disabled={!ready}
          onClick={() => router.push(`/app/${workspaceSlug}?project=${project.id}`)}
          type="button"
        >
          {project.name}
        </button>
        <button aria-label={t('{name} 更多操作', { name: project.name })} className="row-span-2 flex size-7 items-center justify-center self-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-foreground)]" type="button">
          <MoreHorizontal className="size-4" />
        </button>
        <span className="flex items-center gap-1.5 text-[13px] leading-4 tracking-[-0.0762px] text-[var(--app-muted)]">
          <i className={`size-1.5 rounded-full ${ready ? 'bg-[var(--app-success)]' : failed ? 'bg-[var(--app-warning)]' : 'bg-[var(--app-subtle-surface)]'}`} />
          <span className="truncate" title={`${runtime.label} · ${runtime.detail}`}>{activityLabel}</span>
        </span>
      </div>
    </article>
  )
}

export function ProjectsWorkspace({
  activeWorkspace,
  personalWorkspace,
  organizations,
  projects,
  nickname,
  email,
  avatarUrl,
  canManageProjects,
}: ProjectsWorkspaceProps) {
  const t = useT()
  const router = useRouter()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [search, setSearch] = useState('')
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  useEffect(() => {
    if (!projects.some((project) => project.status === 'waiting' || project.runtime_status !== 'ready')) return
    const refresh = window.setInterval(() => router.refresh(), 2_500)
    return () => window.clearInterval(refresh)
  }, [projects, router])

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('openlink-theme') as ThemeMode | null
    if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') setThemeMode(savedTheme)
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const updateSystemTheme = () => setSystemLight(media.matches)
    updateSystemTheme()
    media.addEventListener('change', updateSystemTheme)
    return () => media.removeEventListener('change', updateSystemTheme)
  }, [])

  const activeTheme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

  useEffect(() => {
    const root = document.documentElement
    if (activeTheme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [activeTheme])

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return projects
    return projects.filter((project) => (
      project.name.toLocaleLowerCase().includes(query)
      || project.description.toLocaleLowerCase().includes(query)
      || project.kind.includes(query)
    ))
  }, [projects, search])

  return (
    <OpenLinkThemeProvider theme={activeTheme}>
      <div className="openlink-app-shell flex h-dvh min-h-[500px] overflow-hidden" data-theme={activeTheme}>
        <Sidebar
          activeNavLabel={t('项目')}
          activeWorkspace={activeWorkspace}
          avatarUrl={avatarUrl}
          collapsed={collapsed}
          email={email}
          mobileOpen={mobileOpen}
          nickname={nickname}
          onCloseMobile={() => setMobileOpen(false)}
          onThemeChange={(mode) => {
            setThemeMode(mode)
            window.localStorage.setItem('openlink-theme', mode)
          }}
          onToggle={() => {
            if (mobileOpen) {
              setMobileOpen(false)
              setCollapsed(true)
            } else {
              setCollapsed((value) => !value)
            }
          }}
          organizations={organizations}
          personalWorkspace={personalWorkspace}
          projects={projects}
          themeMode={themeMode}
        />

        <main className="relative min-w-0 flex-1 overflow-y-auto bg-[var(--app-background)]">
          <header className="sticky top-0 z-10 flex h-12 items-center border-b border-[var(--app-border)] bg-[var(--app-background)]/95 px-3 backdrop-blur md:hidden">
            <button aria-label={t('打开侧边栏')} className="flex size-8 items-center justify-center rounded-md hover:bg-[var(--app-surface)]" onClick={() => { setCollapsed(false); setMobileOpen(true) }} type="button">
              <span className="flex w-4 flex-col gap-1"><i className="h-px w-4 bg-[var(--app-muted)]" /><i className="h-px w-4 bg-[var(--app-muted)]" /><i className="h-px w-4 bg-[var(--app-muted)]" /></span>
            </button>
            <span className="ml-2 truncate text-sm font-medium text-[var(--app-foreground)]">{t('Projects')}</span>
          </header>

          {collapsed && (
            <button aria-label={t('展开侧边栏')} className="absolute left-3 top-3 z-20 hidden size-8 items-center justify-center rounded-md hover:bg-[var(--app-surface)] md:flex" onClick={() => setCollapsed(false)} type="button">
              <img alt="" className="app-control-icon size-4" src="/openlink/app/sidebar-expand.svg" />
            </button>
          )}

          <PageTransition className="mx-auto w-full max-w-[1166px] px-6 pb-16 pt-8 sm:px-8 md:px-12 md:pt-10">
            <h1 className="pb-4 text-[32px] font-semibold leading-10 tracking-[-0.8737px] text-[var(--app-foreground)]">{t('Projects')}</h1>

            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] pr-2 focus-within:border-[var(--app-focus-ring)]">
                <span className="flex h-[30px] w-8 shrink-0 items-center justify-center text-[var(--app-muted)]"><Search className="size-4" /></span>
                <input
                  aria-label={t('搜索项目')}
                  className="h-5 min-w-0 flex-1 bg-transparent text-sm tracking-[-0.1504px] text-[var(--app-foreground)] outline-none placeholder:text-[var(--app-subtle-foreground)]"
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  placeholder={t('Search projects...')}
                  type="search"
                  value={search}
                />
              </label>
              <button
                className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-sm font-medium tracking-[-0.1504px] text-[var(--app-foreground)] hover:bg-[var(--app-active)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canManageProjects}
                onClick={() => setNewProjectOpen(true)}
                title={canManageProjects ? t('创建项目') : t('只有组织管理员可以创建项目')}
                type="button"
              >
                <Plus className="size-4" /> {t('Project')}
              </button>
            </div>

            {filteredProjects.length ? (
              <section aria-label={t('项目列表')} className="mt-8 grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
                {filteredProjects.map((project) => (
                  <ProjectCard key={project.id} project={project} workspaceSlug={activeWorkspace.slug} />
                ))}
              </section>
            ) : (
              <section className="mt-8 flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--app-control-border)] px-6 text-center">
                <span className="flex size-12 items-center justify-center rounded-full border border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-muted)]"><Code2 className="size-5" /></span>
                <h2 className="mt-4 text-sm font-medium text-[var(--app-foreground)]">{search ? t('No matching projects') : t('No projects yet')}</h2>
                <p className="mt-1 max-w-sm text-sm leading-5 text-[var(--app-muted)]">{search ? t('Try another search term.') : t('Create a code or research project to give your chats a persistent workspace.')}</p>
                {!search && canManageProjects && (
                  <button className="mt-4 flex h-8 items-center gap-1.5 rounded-md bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:opacity-90" onClick={() => setNewProjectOpen(true)} type="button"><Plus className="size-4" /> {t('New Project')}</button>
                )}
              </section>
            )}
          </PageTransition>
        </main>

        <NewProjectDialog
          onOpenChange={setNewProjectOpen}
          open={newProjectOpen}
          projects={projects}
          workspaceSlug={activeWorkspace.slug}
        />
      </div>
    </OpenLinkThemeProvider>
  )
}

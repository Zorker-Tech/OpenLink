'use client'

import { selectCloudProjectAction, type SelectCloudProjectActionState } from './cloud-project-actions'
import { AppSelect } from '@/components/ui/app-select'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import type { CloudProjectConnectionState, CloudProjectOption } from '@/lib/platform-cloud-project'
import { ArrowRight, ExternalLink, FolderKanban, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useState } from 'react'

const initialState: SelectCloudProjectActionState = { error: null }
const studioOrigin = 'https://dashboard.hydite.com'
const noProjectSelected = '__openlink_no_project_selected__'

export function CloudProjectSetup({
  connectionId,
  connectionState,
  projects,
  prompt,
}: {
  connectionId: string | null
  connectionState: CloudProjectConnectionState
  projects: CloudProjectOption[]
  prompt: string
}) {
  const t = useT()
  const router = useRouter()
  const [selectedProject, setSelectedProject] = useState('')
  const [actionState, formAction, isSelecting] = useActionState(selectCloudProjectAction, initialState)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)

  useEffect(() => {
    if (selectedProject && !projects.some((project) => project.id === selectedProject)) {
      setSelectedProject('')
    }
  }, [projects, selectedProject])

  async function connectVtslx() {
    setConnectionError(null)
    setIsConnecting(true)
    try {
      const params = new URLSearchParams({ step: 'project' })
      if (prompt) params.set('prompt', prompt)
      const response = await fetch('/api/platform/connections/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nextPath: `/app/onboarding?${params.toString()}` }),
      })
      const body = await response.json().catch(() => null) as {
        authorizationUrl?: string
        error?: { code?: string }
      } | null
      if (response.status === 409 && body?.error?.code === 'CLOUD_CONNECTION_ALREADY_EXISTS') {
        router.refresh()
        return
      }
      if (!response.ok || typeof body?.authorizationUrl !== 'string') {
        setConnectionError(t('暂时无法连接 VTSLX，请稍后重试。'))
        return
      }
      window.location.assign(body.authorizationUrl)
    } catch {
      setConnectionError(t('暂时无法连接 VTSLX，请稍后重试。'))
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <div className="space-y-4">
      {connectionState === 'disconnected' && (
        <div className="rounded-2xl border border-border bg-muted/20 p-5 sm:p-6">
          <p className="text-sm leading-6 text-muted-foreground">
            {t('先连接 Hydite 账号，OpenLink 会通过 VTSLX SDK 读取你在 Studio 中可访问的项目。')}
          </p>
          {connectionError && <p className="mt-3 text-sm text-destructive" role="alert">{connectionError}</p>}
          <Button className="mt-5 h-12 w-full rounded-xl" disabled={isConnecting} onClick={connectVtslx} type="button">
            {isConnecting ? t('正在连接…') : t('连接 VTSLX 账号')}
            {!isConnecting && <ArrowRight aria-hidden className="ml-2 size-4" />}
          </Button>
        </div>
      )}

      {connectionState === 'reauth_required' && (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 sm:p-6">
          <p className="text-sm leading-6 text-muted-foreground">
            {t('VTSLX 连接需要重新授权。请先在 Cloud 设置中断开旧连接，再回来重新连接。')}
          </p>
          <a className="mt-4 inline-flex text-sm font-medium text-foreground underline underline-offset-4" href="/settings">
            {t('打开 Cloud 设置')}
          </a>
        </div>
      )}

      {connectionState === 'load_error' && (
        <div className="rounded-2xl border border-border bg-muted/20 p-5 sm:p-6">
          <p className="text-sm leading-6 text-muted-foreground" role="alert">
            {t('暂时无法读取 Studio 项目，请检查 VTSLX 连接后重试。')}
          </p>
          <Button className="mt-4 h-11 rounded-xl" onClick={() => router.refresh()} type="button" variant="outline">
            <RefreshCw aria-hidden className="mr-2 size-4" />{t('重试读取项目')}
          </Button>
        </div>
      )}

      {connectionState === 'active' && (
        <>
          {projects.length > 0 ? (
            <form action={formAction} className="space-y-3">
              <input name="prompt" type="hidden" value={prompt} />
              <input name="connectionId" type="hidden" value={connectionId ?? ''} />
              <input name="platformProjectRef" type="hidden" value={selectedProject} />
              <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between xl:gap-5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t('可访问的 Studio 项目')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('选择要关联到 OpenLink 个人项目的 Studio 项目。')}</p>
                </div>
                <div className="flex min-w-0 items-center gap-2 xl:w-[min(22rem,52%)] xl:shrink-0">
                  <AppSelect
                    ariaLabel={t('选择项目')}
                    className="h-10 min-w-0 flex-1"
                    contentClassName="max-w-[min(22rem,90vw)]"
                    onValueChange={(value) => setSelectedProject(value === noProjectSelected ? '' : value)}
                    options={[
                      { label: t('选择项目'), value: noProjectSelected, disabled: true },
                      ...projects.map((project) => ({
                        description: project.organizationId,
                        icon: <FolderKanban aria-hidden className="size-4 text-muted-foreground" />,
                        label: project.name,
                        value: project.id,
                      })),
                    ]}
                    value={selectedProject || noProjectSelected}
                  />
                  <Button aria-label={t('刷新项目列表')} className="size-10 shrink-0 rounded-xl" onClick={() => router.refresh()} type="button" variant="outline">
                    <RefreshCw aria-hidden className="size-4" />
                  </Button>
                </div>
              </div>
              {actionState.error && <p className="text-sm text-destructive" role="alert">{actionState.error}</p>}
              <Button className="h-12 w-full rounded-xl" disabled={!selectedProject || isSelecting} type="submit">
                {isSelecting ? t('正在关联项目…') : t('关联此 Studio 项目')}
                {!isSelecting && <ArrowRight aria-hidden className="ml-2 size-4" />}
              </Button>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{t('可访问的 Studio 项目')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('选择要关联到 OpenLink 个人项目的 Studio 项目。')}</p>
                </div>
                <Button aria-label={t('刷新项目列表')} className="size-10 shrink-0 rounded-xl" onClick={() => router.refresh()} type="button" variant="outline">
                  <RefreshCw aria-hidden className="size-4" />
                </Button>
              </div>
              <div className="rounded-2xl border border-dashed border-border bg-muted/10 px-5 py-5 text-center">
                <p className="text-sm font-medium text-foreground">{t('还没有可用项目')}</p>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  {t('先在 Hydite Studio 创建组织和项目，回来刷新列表后即可继续。')}
                </p>
              </div>
            </div>
          )}
        </>
      )}

      <div className="rounded-2xl border border-border bg-muted/10 p-4 sm:p-5">
        <p className="text-xs leading-5 text-muted-foreground">
          {t('组织与项目由 Hydite Studio 管理；创建完成后回到这里刷新项目列表。')}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <a
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/30"
            href={`${studioOrigin}/new`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t('创建组织')}<ExternalLink aria-hidden className="size-3.5" />
          </a>
          <a
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/30"
            href={`${studioOrigin}/?next=new-project`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t('创建项目')}<ExternalLink aria-hidden className="size-3.5" />
          </a>
        </div>
      </div>
    </div>
  )
}

'use client'

import {
  createOrganizationAction,
  joinOrganizationAction,
  skipOrganizationAction,
  type OrganizationActionState,
} from '@/app/app/organization-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n/client'
import { Building2, KeyRound, Plus } from 'lucide-react'
import { useActionState, useState } from 'react'

const initialState: OrganizationActionState = { error: null }

export function OrganizationSetup({
  prompt = '',
  showSkip = false,
}: {
  prompt?: string
  showSkip?: boolean
}) {
  const t = useT()
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [createState, createAction, isCreating] = useActionState(createOrganizationAction, initialState)
  const [joinState, joinAction, isJoining] = useActionState(joinOrganizationAction, initialState)
  const inputClassName = 'h-10 rounded-lg border-input bg-background px-3 text-[15px]! text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25'
  const primaryButtonClassName = 'h-10 w-full rounded-lg bg-primary text-primary-foreground hover:bg-primary/90'

  return (
    <div className="space-y-4">
      <div aria-label={t('组织操作')} className="grid grid-cols-2 rounded-lg bg-muted p-1" role="tablist">
        <button
          aria-selected={mode === 'create'}
          className={`flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors ${mode === 'create' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}
          onClick={() => setMode('create')}
          role="tab"
          type="button"
        >
          <Plus className="size-4" />{t('创建组织')}
        </button>
        <button
          aria-selected={mode === 'join'}
          className={`flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors ${mode === 'join' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}
          onClick={() => setMode('join')}
          role="tab"
          type="button"
        >
          <KeyRound className="size-4" />{t('加入组织')}
        </button>
      </div>

      {mode === 'create' ? (
        <form action={createAction} className="space-y-4">
          <input name="prompt" type="hidden" value={prompt} />
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t('组织名称')}</span>
            <Input
              autoComplete="organization"
              autoFocus
              className={inputClassName}
              maxLength={80}
              name="organizationName"
              placeholder={t('例如：Acme Design')}
              required
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">{t('创建后你将成为组织所有者，可以独立管理组织内容、权限与成员。')}</p>
          {createState.error && <p className="text-sm text-destructive" role="alert">{createState.error}</p>}
          <Button className={primaryButtonClassName} disabled={isCreating} type="submit">
            <Building2 className="size-4" />{isCreating ? t('正在创建…') : t('创建组织')}
          </Button>
        </form>
      ) : (
        <form action={joinAction} className="space-y-4">
          <input name="prompt" type="hidden" value={prompt} />
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t('组织邀请码')}</span>
            <Input
              autoComplete="off"
              autoFocus
              className={`${inputClassName} uppercase tracking-[0.18em]`}
              maxLength={32}
              minLength={6}
              name="joinCode"
              placeholder={t('输入邀请码')}
              required
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">{t('加入后组织管理员可以管理你在该组织内的权限，但不会影响你的个人设置。')}</p>
          {joinState.error && <p className="text-sm text-destructive" role="alert">{joinState.error}</p>}
          <Button className={primaryButtonClassName} disabled={isJoining} type="submit">
            <KeyRound className="size-4" />{isJoining ? t('正在加入…') : t('加入组织')}
          </Button>
        </form>
      )}

      {showSkip && (
        <form action={skipOrganizationAction}>
          <input name="prompt" type="hidden" value={prompt} />
          <Button className="h-10 w-full rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground" type="submit" variant="ghost">
            {t('暂时跳过，使用个人工作区')}
          </Button>
        </form>
      )}
    </div>
  )
}

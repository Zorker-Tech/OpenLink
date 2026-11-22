'use client'

import { LogOut } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { OrganizationDialog } from '@/components/organization-dialog'
import { useT } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'
import { createClient } from '@/utils/supabase/client'

export function SettingsAccount({ avatarUrl, cloudRuntime, email, nickname, organizations }: {
  avatarUrl: string | null
  cloudRuntime: boolean
  email: string
  nickname: string
  organizations: OrganizationSummary[]
}) {
  const t = useT()
  const router = useRouter()
  const [organizationOpen, setOrganizationOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState(false)

  const signOut = async () => {
    setSigningOut(true)
    setSignOutError(false)
    try {
      const { error } = await createClient().auth.signOut({ scope: 'local' })
      if (error) throw error
      router.replace('/')
      router.refresh()
    } catch {
      setSignOutError(true)
      setSigningOut(false)
    }
  }

  return (
    <>
      <section aria-labelledby="settings-account-heading" className="settings-group">
        <h2 id="settings-account-heading">{t('账户')}</h2>
        <div className="settings-card settings-account-card">
          <div className="settings-account-identity">
            <span className="settings-account-avatar" aria-hidden="true">
              {avatarUrl ? <img alt="" src={avatarUrl} /> : nickname.trim().charAt(0).toUpperCase() || 'O'}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{nickname}</p>
              <p className="truncate text-[var(--app-muted)]">{email}</p>
            </div>
          </div>
          <div className="settings-account-actions">
            {cloudRuntime ? (
              <Link className="settings-account-action" href="/app/onboarding?step=project">{t('项目设置')}</Link>
            ) : (
              <button className="settings-account-action" onClick={() => setOrganizationOpen(true)} type="button">{t('添加组织')}</button>
            )}
            <button className="settings-account-action" disabled={signingOut} onClick={() => void signOut()} type="button">
              <LogOut aria-hidden="true" size={15} />
              {signingOut ? t('退出中…') : t('退出登录')}
            </button>
          </div>
        </div>
        {!cloudRuntime && organizations.length > 0 && (
          <ul aria-label={t('组织工作区')} className="mt-2 flex flex-wrap gap-2">
            {organizations.map(organization => (
              <li key={organization.id}>
                <Link className="settings-account-action" href={`/app/${encodeURIComponent(organization.workspaceSlug)}`}>{organization.name}</Link>
              </li>
            ))}
          </ul>
        )}
        {signOutError ? <p className="mt-2 text-[var(--app-danger)]" role="alert">{t('退出登录失败')}</p> : null}
      </section>
      <OrganizationDialog open={organizationOpen} onOpenChange={setOrganizationOpen} />
    </>
  )
}

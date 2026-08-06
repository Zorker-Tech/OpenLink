'use client'

import type { OrganizationSummary } from '@/lib/organizations'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Building2, Check, ChevronsUpDown, Plus, UserRound } from 'lucide-react'
import { useRouter } from 'next/navigation'

export interface PersonalWorkspaceSummary {
  name: string
  slug: string
}

export interface ActiveWorkspaceSummary {
  name: string
  slug: string
  scopeType: 'personal' | 'organization'
  organizationId: string | null
}

function ScopeAvatar({ label, organization }: { label: string; organization?: boolean }) {
  return (
    <span className={`flex size-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${organization ? 'bg-muted text-foreground' : 'bg-[linear-gradient(135deg,#7c3aed,#ec4899)] text-white'}`}>
      {label.trim().charAt(0).toUpperCase() || 'O'}
    </span>
  )
}

export function WorkspaceSwitcher({
  activeWorkspace,
  organizations,
  personalWorkspace,
  onAddOrganization,
}: {
  activeWorkspace: ActiveWorkspaceSummary
  organizations: OrganizationSummary[]
  personalWorkspace: PersonalWorkspaceSummary
  onAddOrganization: () => void
}) {
  const router = useRouter()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-transparent pl-1.5 hover:bg-[var(--app-surface)]" type="button" />
        }
      >
        <ScopeAvatar label={activeWorkspace.name} organization={activeWorkspace.scopeType === 'organization'} />
        <span className="ml-1.5 min-w-0 flex-1 truncate text-left text-sm font-medium tracking-[-0.1504px] text-[var(--app-foreground)]">
          {activeWorkspace.scopeType === 'personal' ? '个人' : activeWorkspace.name}
        </span>
        <ChevronsUpDown className="mx-1 size-3.5 text-[var(--app-muted)]" strokeWidth={1.8} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[264px] border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_12px_32px_var(--app-shadow)] ring-0"
        sideOffset={6}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 py-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">工作区</DropdownMenuLabel>
          <DropdownMenuItem
            className="h-10 cursor-pointer gap-2 px-2 focus:bg-accent focus:text-accent-foreground"
            onClick={() => router.push(`/app/${personalWorkspace.slug}`)}
          >
            <UserRound className="size-4" />
            <span className="min-w-0 flex-1 truncate">个人</span>
            {activeWorkspace.scopeType === 'personal' && <Check className="size-4" />}
          </DropdownMenuItem>
          {organizations.length > 0 && <DropdownMenuSeparator />}
          {organizations.map((organization) => (
            <DropdownMenuItem
              className="h-10 cursor-pointer gap-2 px-2 focus:bg-accent focus:text-accent-foreground"
              key={organization.id}
              onClick={() => router.push(`/app/${organization.workspaceSlug}`)}
            >
              <Building2 className="size-4" />
              <span className="min-w-0 flex-1 truncate">{organization.name}</span>
              {activeWorkspace.organizationId === organization.id && <Check className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="h-10 cursor-pointer gap-2 px-2 focus:bg-accent focus:text-accent-foreground"
          onClick={onAddOrganization}
        >
          <Plus className="size-4" />
          <span>{organizations.length ? '创建或加入组织' : '添加组织'}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

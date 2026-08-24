'use client'

import {
  PromptInputActionAddAttachments,
  PromptInputButton,
} from '@/components/ai-elements/prompt-input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import FigmaColor from '@lobehub/icons/es/Figma/components/Color'
import GithubMono from '@lobehub/icons/es/Github/components/Mono'
import {
  BookOpen,
  ChevronRight,
  Folder,
  ImageIcon,
  Import,
  Network,
  PanelsTopLeft,
  Plus,
  Shapes,
  UploadCloud,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'

export interface PromptAddMenuProps {
  variant: 'home' | 'session'
  className?: string
}

const itemClassName =
  'h-8 cursor-pointer gap-2 rounded-lg px-3 text-[14px] font-normal leading-5 text-[var(--app-foreground)] focus:bg-[var(--app-hover)] focus:text-[var(--app-foreground)]'

const iconClassName = 'size-4 text-[var(--app-muted)]'

function PendingFeatureItem({
  icon: Icon,
  label,
}: {
  icon: LucideIcon
  label: string
}) {
  return (
    <DropdownMenuItem className={itemClassName} closeOnClick={false}>
      <Icon aria-hidden className={iconClassName} />
      <span className="min-w-0 flex-1">{label}</span>
      <ChevronRight aria-hidden className="size-4 text-[var(--app-muted)]" />
    </DropdownMenuItem>
  )
}

/** Figma-matched Add menu shared by the home and active-session composers. */
export function PromptAddMenu({ variant, className }: PromptAddMenuProps) {
  const [generateImages, setGenerateImages] = useState(true)
  const isHome = variant === 'home'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label="打开添加菜单"
            className={cn(
              'size-7 shrink-0 rounded-md p-0 transition-[color,background-color,border-color,opacity] active:translate-y-0!',
              isHome
                ? 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'
                : 'text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]',
              className,
            )}
            type="button"
          />
        }
      >
        {isHome
          ? <img alt="" className="app-control-icon size-4" src="/openlink/app/plus.svg" />
          : <Plus aria-hidden className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[250px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-[7px] text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)] ring-0"
        side="top"
        sideOffset={8}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={cn(itemClassName, 'data-popup-open:bg-[var(--app-hover)] data-popup-open:text-[var(--app-foreground)] [&>svg:last-child]:size-4 [&>svg:last-child]:text-[var(--app-muted)]')}>
            <Import aria-hidden className={iconClassName} />
            <span>Import from...</span>
            <span aria-hidden className="ml-auto flex items-center gap-1 text-[var(--app-muted)]">
              {isHome && <GithubMono size={14} />}
              <FigmaColor size={14} />
              <PanelsTopLeft className="size-3.5 text-blue-500" />
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[168px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-[7px] text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)] ring-0">
            {isHome && (
              <DropdownMenuItem className={itemClassName} closeOnClick={false}>
                <GithubMono aria-hidden size={16} />
                <span>GitHub</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className={itemClassName} closeOnClick={false}>
              <FigmaColor aria-hidden size={16} />
              <span>Figma</span>
            </DropdownMenuItem>
            <DropdownMenuItem className={itemClassName} closeOnClick={false}>
              <PanelsTopLeft aria-hidden className={cn(iconClassName, 'text-blue-500')} />
              <span>Design file</span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <PromptInputActionAddAttachments
          className={itemClassName}
          label="Upload from computer"
        >
          <UploadCloud aria-hidden className={iconClassName} />
          <span>Upload from computer</span>
        </PromptInputActionAddAttachments>

        <DropdownMenuSeparator className="-mx-[7px] my-[7px] bg-[var(--app-border)]" />

        <DropdownMenuItem
          aria-checked={generateImages}
          className={itemClassName}
          closeOnClick={false}
          onClick={() => setGenerateImages((current) => !current)}
          role="menuitemcheckbox"
        >
          <ImageIcon aria-hidden className={iconClassName} />
          <span className="min-w-0 flex-1">Generate Images</span>
          <span
            aria-hidden
            className={cn(
              'relative h-[18px] w-8 shrink-0 rounded-full transition-colors',
              generateImages ? 'bg-[var(--app-brand)]' : 'bg-[var(--app-active)]',
            )}
          >
            <span className={cn('absolute top-0.5 size-3.5 rounded-full bg-[var(--app-surface)] shadow-sm transition-transform', generateImages ? 'translate-x-4' : 'translate-x-0.5')} />
          </span>
        </DropdownMenuItem>

        <PendingFeatureItem icon={Zap} label="Skills" />
        {isHome && <PendingFeatureItem icon={Shapes} label="Design Systems" />}
        {isHome && <PendingFeatureItem icon={Folder} label="Folder" />}
        <PendingFeatureItem icon={BookOpen} label="Instructions" />
        <PendingFeatureItem icon={Network} label="MCPs" />
        <PendingFeatureItem icon={Zap} label="Auto Permissions" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

'use client'

import { WorkspacePrompt } from '@/components/workspace-prompt'
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Send } from 'lucide-react'
import { useT } from '@/lib/i18n/client'
import type { ComposerContext } from '@/lib/composer-context'

export type { ComposerContext, ComposerWorkspace } from '@/lib/composer-context'

interface PromptComposerProps {
  user: { email: string | null; name: string | null } | null
  composerContext: ComposerContext | null
}

/**
 * Marketing-page wrapper around the canonical {@link WorkspacePrompt}. It
 * adds the workspace switcher (the marketing page is not workspace-scoped),
 * injects real voice input, and gates anonymous visitors to login/register —
 * the composer itself remains the same standardized component used in-app.
 */

function loginRedirect(prompt: string): string {
  return `/login?next=${encodeURIComponent(`/app?prompt=${encodeURIComponent(prompt)}`)}`
}

export function PromptComposer({ user, composerContext }: PromptComposerProps) {
  const router = useRouter()
  const t = useT()
  const workspaces = composerContext?.workspaces ?? []
  const [selectedSlug, setSelectedSlug] = useState<string>(workspaces[0]?.slug ?? '')
  const [input, setInput] = useState('')
  const workspace = workspaces.find((candidate) => candidate.slug === selectedSlug) ?? workspaces[0]

  // Anonymous visitors get a lightweight input that gates to login/register on
  // submit; signing in continues through the /app prompt chain.
  if (!user || !composerContext || !workspace) {
    return (
      <div className="mx-auto w-full max-w-[690px]">
        <PromptInput
          className="[&>[data-slot=input-group]]:min-h-[108px] [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:border-[var(--app-control-border)] [&>[data-slot=input-group]]:bg-[var(--app-surface)] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:focus-within:border-[var(--app-focus-ring)] [&>[data-slot=input-group]]:focus-within:ring-0"
          onSubmit={() => {
            const prompt = input.trim()
            if (prompt) router.push(loginRedirect(prompt))
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea
              aria-label={t('描述您想创建的内容')}
              className="min-h-[54px]! px-3 pt-3 text-[15px] text-[var(--app-foreground)] placeholder:text-[var(--app-subtle-foreground)]"
              onChange={(event) => setInput(event.currentTarget.value)}
              placeholder=""
              value={input}
            />
          </PromptInputBody>
          <PromptInputFooter className="h-10 px-3 pb-3">
            <PromptInputSubmit aria-label={t('发送')} className="size-7 rounded-full border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] p-0 text-[var(--app-submit-foreground)] hover:bg-[var(--app-submit-hover)]">
              <Send aria-hidden className="size-3.5" />
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[700px]">
      {workspaces.length > 1 && (
        <div className="mb-3 flex items-center gap-1.5 px-1">
          {workspaces.map((candidate) => (
            <button
              aria-pressed={candidate.slug === workspace.slug}
              className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${candidate.slug === workspace.slug ? 'border-transparent bg-[var(--app-active)] text-[var(--app-foreground)]' : 'border-[var(--app-control-border)] bg-[var(--app-surface)] text-[var(--app-muted)] hover:text-[var(--app-foreground)]'}`}
              key={candidate.id}
              onClick={() => setSelectedSlug(candidate.slug)}
              type="button"
            >
              {candidate.name}
              <span className="text-[10px] text-[var(--app-subtle-foreground)]">{candidate.scopeType === 'organization' ? t('组织') : t('个人')}</span>
            </button>
          ))}
        </div>
      )}
      <WorkspacePrompt
        configuredModels={composerContext.models}
        defaultProject={workspace.defaultProject}
        initialPrompt=""
        projects={workspace.projects}
        onUnauthenticated={() => router.push('/login?next=/app')}
        workspaceSlug={workspace.slug}
      />
    </div>
  )
}

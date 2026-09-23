'use client'

import {
  createUserSkillAction,
  deleteUserSkillAction,
  saveUserSkillAction,
} from '@/app/settings/skills/actions'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useT } from '@/lib/i18n/client'
import type { Translator } from '@/lib/i18n/messages'
import { readSkillZip } from '@/lib/read-skill-zip'
import type { UserSkill, UserSkillSummary } from '@/lib/user-skill-types'
import {
  ChevronDown,
  ChevronRight,
  FileInput,
  FileText,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'

interface SkillsWorkspaceProps {
  currentSkill?: UserSkill
  skills: UserSkillSummary[]
}

function errorMessages(t: Translator): Record<string, string> {
  return {
    INVALID_ZIP: t('无法读取这个 ZIP 文件。'),
    SKILL_MD_NOT_FOUND: t('ZIP 中没有找到 SKILL.md。'),
    SKILL_TOO_LARGE: t('SKILL.md 不能超过 200 KB。'),
    ZIP_TOO_LARGE: t('ZIP 文件不能超过 5 MB。'),
    ZIP_COMPRESSION_UNSUPPORTED: t('这个 ZIP 使用了暂不支持的压缩格式。'),
    ZIP_DECOMPRESSION_UNSUPPORTED: t('当前浏览器不支持 ZIP 解压。'),
  }
}

function messageFor(error: unknown, fallback: string, t: Translator) {
  const key = error instanceof Error ? error.message : ''
  return errorMessages(t)[key] ?? (key && !key.includes('_') ? key : fallback)
}

export function SkillsWorkspace({ currentSkill, skills }: SkillsWorkspaceProps) {
  const t = useT()
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const createSkill = (name: string, content?: string) => {
    setActionError(null)
    startTransition(async () => {
      const result = await createUserSkillAction({ name, ...(content !== undefined ? { content } : {}) })
      if (!result.ok) {
        setActionError(messageFor(new Error(result.error), t('创建 Skill 失败。'), t))
        return
      }
      setCreateOpen(false)
      setCreateName('')
      router.push(result.path)
    })
  }

  const importZip = async (file: File) => {
    setActionError(null)
    try {
      const imported = await readSkillZip(file)
      createSkill(imported.name, imported.content)
    } catch (error) {
      setActionError(messageFor(error, t('导入 ZIP 失败。'), t))
    }
  }

  return (
    <div className="flex size-full min-w-0 bg-[var(--app-background)]">
      <input
        accept=".zip,application/zip"
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void importZip(file)
        }}
        ref={fileInputRef}
        type="file"
      />
      <SkillsNavigation
        currentSkillId={currentSkill?.id}
        importing={pending}
        onCreate={() => setCreateOpen(true)}
        onImport={() => fileInputRef.current?.click()}
        skills={skills}
      />
      {currentSkill
        ? <SkillEditor key={currentSkill.id} skill={currentSkill} />
        : <SkillsEmptyState disabled={pending} onCreate={() => setCreateOpen(true)} onImport={() => fileInputRef.current?.click()} />}

      {actionError && (
        <div className="absolute bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-destructive/30 bg-[var(--app-elevated)] px-3 py-2 text-xs text-destructive shadow-lg" role="alert">
          {actionError}
        </div>
      )}

      <Dialog onOpenChange={setCreateOpen} open={createOpen}>
        <DialogContent className="border border-[var(--app-border)] bg-[var(--app-elevated)] text-[var(--app-foreground)] ring-0">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (createName.trim()) createSkill(createName)
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('创建 Skill')}</DialogTitle>
              <DialogDescription>{t('输入一个名称，OpenLink 会创建标准的 SKILL.md。')}</DialogDescription>
            </DialogHeader>
            <input
              autoFocus
              className="mt-4 h-10 w-full rounded-lg border border-[var(--app-control-border)] bg-[var(--app-background)] px-3 text-sm outline-none focus:border-[var(--app-muted)]"
              maxLength={64}
              onChange={(event) => setCreateName(event.currentTarget.value)}
              placeholder={t('例如：frontend-review')}
              value={createName}
            />
            <DialogFooter className="mt-4 border-[var(--app-border)] bg-[var(--app-surface)]">
              <DialogClose render={<button className="h-9 rounded-lg border border-[var(--app-control-border)] px-4 text-sm hover:bg-[var(--app-hover)]" type="button" />}>{t('取消')}</DialogClose>
              <button className="h-9 rounded-lg bg-[var(--app-submit-background)] px-4 text-sm font-medium text-[var(--app-submit-foreground)] disabled:opacity-40" disabled={!createName.trim() || pending} type="submit">{t('创建')}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SkillsNavigation({ currentSkillId, importing, onCreate, onImport, skills }: {
  currentSkillId?: string
  importing: boolean
  onCreate: () => void
  onImport: () => void
  skills: UserSkillSummary[]
}) {
  const t = useT()
  const [wideViewport, setWideViewport] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(min-width: 640px)')
    const update = () => setWideViewport(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return (
    <aside
      className={`openlink-skills-navigation h-full shrink-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-background)] ${currentSkillId ? 'hidden sm:flex' : 'flex'}`}
      style={wideViewport
        ? { flexBasis: '288px', maxWidth: '288px', minWidth: '288px', width: '288px' }
        : { flexBasis: '100%', maxWidth: '100%', minWidth: '100%', width: '100%' }}
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--app-border)] pl-3 pr-2">
        <h1 className="text-sm font-semibold tracking-[-0.43px] text-[var(--app-foreground)]">Skills</h1>
        <div className="flex items-center gap-1">
          <button aria-label={t('导入 ZIP')} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)] disabled:opacity-40" disabled={importing} onClick={onImport} type="button"><FileInput className="size-4" strokeWidth={1.8} /></button>
          <button aria-label={t('创建 Skill')} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" onClick={onCreate} type="button"><Plus className="size-4" strokeWidth={1.8} /></button>
        </div>
      </header>
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-[var(--app-border)] px-3 py-2">
        <span aria-current="true" className="flex h-7 items-center rounded-md bg-[var(--app-selected)] px-2 text-sm font-medium text-[var(--app-foreground)]">User</span>
        <span aria-disabled="true" className="flex h-7 cursor-not-allowed items-center rounded-md px-2 text-sm font-medium text-[var(--app-subtle)] opacity-50" title={t('Team Skills 即将开放')}>Team</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {skills.map((skill) => {
          const active = skill.id === currentSkillId
          return (
            <div className="px-2 py-px" key={skill.id}>
              <Link className="flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" href={`/settings/skills/${skill.id}`}>
                {active ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                <span className="min-w-0 flex-1 truncate">{skill.name}</span>
              </Link>
              {active && (
                <Link aria-current="page" className="ml-2 flex h-8 items-center gap-2 rounded-md bg-[var(--app-selected)] pl-4 pr-2 text-sm text-[var(--app-foreground)]" href={`/settings/skills/${skill.id}`}>
                  <FileText className="size-4" strokeWidth={1.7} />
                  <span>SKILL.md</span>
                </Link>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function SkillsEmptyState({ disabled, onCreate, onImport }: { disabled: boolean; onCreate: () => void; onImport: () => void }) {
  return (
    <main className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-3 sm:flex">
      <p className="text-xs leading-4 text-[var(--app-subtle)]">Select a skill to edit</p>
      <p className="text-xs leading-4 text-[var(--app-subtle)]">or</p>
      <div className="flex items-center gap-2">
        <button className="flex h-10 items-center gap-1.5 rounded-lg border border-[var(--app-submit-background)] bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:opacity-90" onClick={onCreate} type="button"><Plus className="size-4" />Create a skill</button>
        <button className="flex h-10 items-center gap-1.5 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-elevated)] px-3 text-sm font-medium text-[var(--app-foreground)] hover:bg-[var(--app-hover)] disabled:opacity-40" disabled={disabled} onClick={onImport} type="button"><FileInput className="size-4" />Import ZIP</button>
      </div>
    </main>
  )
}

function SkillEditor({ skill }: { skill: UserSkill }) {
  const t = useT()
  const router = useRouter()
  const [content, setContent] = useState(skill.content)
  const [savedContent, setSavedContent] = useState(skill.content)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const dirty = content !== savedContent

  useEffect(() => {
    setContent(skill.content)
    setSavedContent(skill.content)
    setError(null)
  }, [skill])

  const save = () => {
    setError(null)
    startTransition(async () => {
      const result = await saveUserSkillAction({ skillId: skill.id, content })
      if (!result.ok) {
        setError(messageFor(new Error(result.error), t('保存失败。'), t))
        return
      }
      setSavedContent(content)
      router.refresh()
    })
  }

  const remove = () => {
    setError(null)
    startTransition(async () => {
      const result = await deleteUserSkillAction(skill.id)
      if (!result.ok) {
        setError(messageFor(new Error(result.error), t('删除失败。'), t))
        return
      }
      router.push(result.path)
    })
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--app-background)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--app-border)] pl-3 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm tracking-[-0.43px]">
          <span className="truncate text-[var(--app-muted)]">{skill.name}</span>
          <span className="text-[var(--app-subtle)]">/</span>
          <strong className="font-semibold text-[var(--app-foreground)]">SKILL.md</strong>
          <span className="ml-1 text-xs tracking-normal text-[var(--app-subtle)]">{content.length.toLocaleString()} chars</span>
        </div>
        {error && <span className="max-w-[240px] truncate text-xs text-destructive" role="alert">{error}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label={t('更多操作')} className="flex size-8 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" type="button" />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40 border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 text-[var(--app-foreground)] shadow-lg ring-0">
            <DropdownMenuItem className="h-8 cursor-pointer gap-2 rounded-md px-2 text-sm text-destructive focus:bg-destructive/10 focus:text-destructive" onClick={remove}>
              <Trash2 className="size-4" />{t('删除 Skill')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button className="h-8 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:opacity-90 disabled:bg-[var(--app-active)] disabled:text-[var(--app-subtle)] disabled:opacity-100" disabled={!dirty || pending} onClick={save} type="button">{pending ? 'Saving…' : 'Save'}</button>
      </header>
      <textarea
        aria-label={t('SKILL.md 内容')}
        className="min-h-0 flex-1 resize-none bg-transparent p-6 font-mono text-xs leading-4 text-[var(--app-foreground)] outline-none placeholder:text-[var(--app-subtle)]"
        maxLength={200_000}
        onChange={(event) => setContent(event.currentTarget.value)}
        placeholder="The description field controls when OpenLink triggers this skill. The body contains the instructions. Keep SKILL.md concise and use reference files for detailed content."
        spellCheck={false}
        value={content}
      />
    </main>
  )
}

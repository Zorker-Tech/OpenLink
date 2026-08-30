'use client'

import { PromptInputActionAddAttachments, PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { AccessMode } from '@/lib/chat-sessions'
import type { AgentKind } from '@/lib/chat-session-types'
import type { CodexComposerResources, CodexPluginResource, CodexSkillResource, RuntimeComposerResources } from '@/lib/composer-resources'
import type { UserSkill } from '@/lib/user-skill-types'
import { cn } from '@/lib/utils'
import FigmaColor from '@lobehub/icons/es/Figma/components/Color'
import GithubMono from '@lobehub/icons/es/Github/components/Mono'
import { BookOpen, Check, ExternalLink, Folder, Import, Network, PackagePlus, PanelsTopLeft, Plus, Shapes, ShieldCheck, UploadCloud, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'

export interface PromptAddMenuProps {
  variant: 'home' | 'session'
  className?: string
  agent?: AgentKind
  skills?: UserSkill[]
  customInstructions?: string
  runtimeResources?: RuntimeComposerResources | null
  accessMode?: AccessMode
  codexResources?: CodexComposerResources | null
  onInsertText?: (text: string) => void
  onAccessModeChange?: (mode: AccessMode) => void
  onInstallPlugin?: (pluginId: string) => Promise<void>
}

const itemClassName = 'h-8 cursor-pointer gap-2 rounded-lg px-3 text-[14px] font-normal leading-5 text-[var(--app-foreground)] focus:bg-[var(--app-hover)] focus:text-[var(--app-foreground)]'
const iconClassName = 'size-4 text-[var(--app-muted)]'
const subMenuClassName = 'max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-[7px] text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)] ring-0'

function MenuHint({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-xs font-normal text-[var(--app-muted)]" role="status">{children}</div>
}

function skillPrompt(skill: UserSkill) {
  return `请在本次任务中使用已保存的技能「${skill.name}」。\n\n<openlink-skill name="${skill.slug}">\n${skill.content}\n</openlink-skill>`
}

function codexSkillPrompt(skill: CodexSkillResource) {
  return skill.defaultPrompt || `请在本次任务中使用 Codex ${skill.source === 'builtin' ? '内置' : '插件'}技能「${skill.name}」。`
}

function instructionPrompt(instructions: string) {
  return `请在本次任务中遵循以下已保存的用户指令：\n\n<openlink-instructions>\n${instructions}\n</openlink-instructions>`
}

function PluginDialog({ open, onOpenChange, plugins, onInstall }: { open: boolean; onOpenChange: (open: boolean) => void; plugins: CodexPluginResource[]; onInstall?: (pluginId: string) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selected = plugins.find((plugin) => plugin.pluginId === selectedId) ?? null
  const available = useMemo(() => [...plugins].sort((a, b) => Number(b.installed) - Number(a.installed) || a.displayName.localeCompare(b.displayName)), [plugins])
  async function install() {
    if (!selected || !onInstall) return
    setInstallingId(selected.pluginId); setError(null)
    try { await onInstall(selected.pluginId) } catch (cause) { setError(cause instanceof Error ? cause.message : '插件安装失败，请稍后重试。') } finally { setInstallingId(null) }
  }
  return <Dialog onOpenChange={(nextOpen) => { onOpenChange(nextOpen); if (!nextOpen) { setSelectedId(null); setError(null) } }} open={open}>
    <DialogContent className="h-[min(68vh,620px)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-0 text-[var(--app-foreground)] shadow-[0_24px_64px_var(--app-shadow)] ring-0" style={{ width: 'min(1100px, calc(100vw - 64px))', maxWidth: '1100px' }}>
      <DialogHeader className="border-b border-[var(--app-border)] px-5 py-4 pr-12"><DialogTitle>Codex 插件市场</DialogTitle><DialogDescription className="text-[var(--app-muted)]">从当前 Codex 已配置的 marketplace 读取；详情来自插件的 <code>.codex-plugin/plugin.json</code>。</DialogDescription></DialogHeader>
      {!selected ? <div className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">{available.length ? available.map((plugin) => <button className="flex min-h-40 flex-col items-start rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-4 text-left transition-colors hover:bg-[var(--app-hover)]" key={plugin.pluginId} onClick={() => { setSelectedId(plugin.pluginId); setError(null) }} type="button"><span className="flex w-full items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--app-active)]"><PackagePlus className="size-4 text-[var(--app-muted)]" /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate font-medium">{plugin.displayName}</span>{plugin.installed && <span className="rounded-full bg-[var(--app-active)] px-1.5 py-0.5 text-[10px] text-[var(--app-muted)]">已安装</span>}</span><span className="mt-2 block line-clamp-3 text-xs leading-5 text-[var(--app-muted)]">{plugin.shortDescription || 'Codex 插件'}</span></span></span><span className="mt-auto pt-3 text-[11px] text-[var(--app-muted)]">{plugin.marketplaceName} · v{plugin.version}</span></button>) : <MenuHint>当前 Codex 未返回可用插件。</MenuHint>}</div> : <div className="min-h-0 overflow-y-auto p-5"><button className="mb-4 text-xs text-[var(--app-muted)] hover:text-[var(--app-foreground)]" onClick={() => { setSelectedId(null); setError(null) }} type="button">← 返回插件列表</button><div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--app-active)]"><PackagePlus className="size-5 text-[var(--app-muted)]" /></span><div className="min-w-0"><h3 className="text-lg font-semibold">{selected.displayName}</h3><p className="mt-1 text-sm leading-6 text-[var(--app-muted)]">{selected.longDescription || selected.shortDescription || 'Codex 插件'}</p></div></div><dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 text-sm"><div><dt className="text-xs text-[var(--app-muted)]">插件 ID</dt><dd className="mt-0.5 break-all">{selected.pluginId}</dd></div><div><dt className="text-xs text-[var(--app-muted)]">版本</dt><dd className="mt-0.5">{selected.version || '未声明'}</dd></div>{selected.developerName && <div><dt className="text-xs text-[var(--app-muted)]">开发者</dt><dd className="mt-0.5">{selected.developerName}</dd></div>}{selected.category && <div><dt className="text-xs text-[var(--app-muted)]">分类</dt><dd className="mt-0.5">{selected.category}</dd></div>}{selected.license && <div><dt className="text-xs text-[var(--app-muted)]">许可证</dt><dd className="mt-0.5">{selected.license}</dd></div>}{selected.capabilities.length > 0 && <div><dt className="text-xs text-[var(--app-muted)]">能力</dt><dd className="mt-0.5">{selected.capabilities.join(' · ')}</dd></div>}</dl>{selected.keywords.length > 0 && <div className="mt-5 flex flex-wrap gap-1.5">{selected.keywords.map((keyword) => <span className="rounded-full bg-[var(--app-active)] px-2 py-1 text-xs text-[var(--app-muted)]" key={keyword}>{keyword}</span>)}</div>}{selected.defaultPrompts.length > 0 && <div className="mt-5"><p className="text-xs text-[var(--app-muted)]">默认提示词</p><ul className="mt-2 space-y-1.5 text-sm text-[var(--app-foreground)]">{selected.defaultPrompts.map((prompt) => <li key={prompt}>• {prompt}</li>)}</ul></div>}{(selected.websiteUrl || selected.homepage || selected.repository || selected.privacyPolicyUrl || selected.termsOfServiceUrl) && <div className="mt-5 flex flex-wrap gap-3 text-xs">{[[selected.websiteUrl || selected.homepage, '网站'], [selected.repository, '仓库'], [selected.privacyPolicyUrl, '隐私'], [selected.termsOfServiceUrl, '条款']].flatMap(([href, label]) => typeof href === 'string' ? [<a className="inline-flex items-center gap-1 text-[var(--app-brand)] hover:underline" href={href} key={label} rel="noreferrer" target="_blank">{label}<ExternalLink className="size-3" /></a>] : [])}</div>}{error && <p className="mt-4 text-sm text-[var(--app-danger)]">{error}</p>}<div className="mt-6 flex justify-end gap-2">{selected.installed ? <Button disabled size="sm" variant="secondary"><Check />已安装{selected.enabled ? '并启用' : ''}</Button> : <Button disabled={installingId === selected.pluginId || selected.installPolicy !== 'AVAILABLE'} onClick={() => void install()} size="sm">{installingId === selected.pluginId ? '正在安装…' : selected.installPolicy === 'AVAILABLE' ? '安装插件' : '此插件不可安装'}</Button>}</div></div>}
    </DialogContent>
  </Dialog>
}

export function PromptAddMenu({ variant, className, agent, skills = [], customInstructions = '', runtimeResources, accessMode, codexResources, onInsertText, onAccessModeChange, onInstallPlugin }: PromptAddMenuProps) {
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const isHome = variant === 'home'
  const runtimeName = runtimeResources?.source ?? (agent === 'pi' ? 'Pi Agent' : 'Codex Agent')
  // Persisted session state is available before an on-demand runtime is
  // leased. Once the worker reports its policy, it becomes the source of
  // truth; this fallback keeps the selector actionable during warmup.
  const permissions = runtimeResources?.accessMode ?? accessMode
  const codexSkills = codexResources?.skills ?? []
  return <><DropdownMenu><DropdownMenuTrigger render={<PromptInputButton aria-label="打开添加菜单" className={cn('size-7 shrink-0 rounded-md p-0 transition-[color,background-color,border-color,opacity] active:translate-y-0!', isHome ? 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]', className)} type="button" />}>{isHome ? <img alt="" className="app-control-icon size-4" src="/openlink/app/plus.svg" /> : <Plus aria-hidden className="size-4" />}</DropdownMenuTrigger><DropdownMenuContent align="start" className="w-[250px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-[7px] text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)] ring-0" side="top" sideOffset={8}>
    <DropdownMenuSub><DropdownMenuSubTrigger className={cn(itemClassName, 'data-popup-open:bg-[var(--app-hover)] data-popup-open:text-[var(--app-foreground)] [&>svg:last-child]:size-4 [&>svg:last-child]:text-[var(--app-muted)]')}><Import aria-hidden className={iconClassName} /><span>Import from...</span><span aria-hidden className="ml-auto flex items-center gap-1 text-[var(--app-muted)]">{isHome && <GithubMono size={14} />}<FigmaColor size={14} /><PanelsTopLeft className="size-3.5 text-blue-500" /></span></DropdownMenuSubTrigger><DropdownMenuSubContent className={cn('w-[210px]', subMenuClassName)}>{isHome && <DropdownMenuItem className={itemClassName} disabled><GithubMono aria-hidden size={16} /><span>GitHub（即将推出）</span></DropdownMenuItem>}<DropdownMenuItem className={itemClassName} disabled><FigmaColor aria-hidden size={16} /><span>Figma（即将推出）</span></DropdownMenuItem><DropdownMenuItem className={itemClassName} disabled><PanelsTopLeft aria-hidden className={cn(iconClassName, 'text-blue-500')} /><span>Design file（即将推出）</span></DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub>
    <PromptInputActionAddAttachments className={itemClassName} label="Upload from computer"><UploadCloud aria-hidden className={iconClassName} /><span>Upload from computer</span></PromptInputActionAddAttachments><DropdownMenuSeparator className="-mx-[7px] my-[7px] bg-[var(--app-border)]" />
    <DropdownMenuSub><DropdownMenuSubTrigger className={itemClassName}><Zap aria-hidden className={iconClassName} /><span className="min-w-0 flex-1">Skills</span><span className="w-7 text-right text-[11px] tabular-nums text-[var(--app-muted)]">{skills.length + codexSkills.length || ''}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className={cn('w-[310px]', subMenuClassName)}>{agent === 'codex' && <><MenuHint>Codex 内置与已安装插件技能</MenuHint>{codexSkills.length ? codexSkills.map((skill) => <DropdownMenuItem className={itemClassName} key={skill.id} onClick={() => onInsertText?.(codexSkillPrompt(skill))}><Zap aria-hidden className={iconClassName} /><span className="min-w-0 flex-1 truncate">{skill.name}</span><span className="text-[10px] text-[var(--app-muted)]">{skill.source === 'builtin' ? '内置' : '插件'}</span></DropdownMenuItem>) : <MenuHint>正在读取 Codex 已安装技能。</MenuHint>}</>}{skills.length > 0 && <><MenuHint>已保存技能</MenuHint>{skills.map((skill) => <DropdownMenuItem className={itemClassName} key={skill.id} onClick={() => onInsertText?.(skillPrompt(skill))}><Zap aria-hidden className={iconClassName} /><span className="truncate">{skill.name}</span></DropdownMenuItem>)}</>}{agent !== 'codex' && !skills.length && <MenuHint>尚未保存技能，可在设置中创建。</MenuHint>}</DropdownMenuSubContent></DropdownMenuSub>
    {agent === 'codex' && <DropdownMenuSub><DropdownMenuSubTrigger className={itemClassName}><PackagePlus aria-hidden className={iconClassName} /><span className="min-w-0 flex-1">Plugins</span><span className="w-7 text-right text-[11px] tabular-nums text-[var(--app-muted)]">{codexResources?.plugins.length ?? ''}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className={cn('w-[250px]', subMenuClassName)}><DropdownMenuItem className={itemClassName} onClick={() => setPluginsOpen(true)}><PackagePlus aria-hidden className={iconClassName} /><span>打开 Codex 插件市场</span></DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub>}{isHome && <DropdownMenuItem className={itemClassName} disabled><Shapes aria-hidden className={iconClassName} /><span>Design Systems（即将推出）</span></DropdownMenuItem>}{isHome && <DropdownMenuItem className={itemClassName} disabled><Folder aria-hidden className={iconClassName} /><span>Folder（即将推出）</span></DropdownMenuItem>}
    <DropdownMenuSub><DropdownMenuSubTrigger className={itemClassName}><BookOpen aria-hidden className={iconClassName} /><span>Instructions</span></DropdownMenuSubTrigger><DropdownMenuSubContent className={cn('w-[288px]', subMenuClassName)}>{customInstructions.trim() ? <DropdownMenuItem className={itemClassName} onClick={() => onInsertText?.(instructionPrompt(customInstructions.trim()))}><BookOpen aria-hidden className={iconClassName} /><span>已保存的自定义指令</span></DropdownMenuItem> : <MenuHint>尚未配置自定义指令。</MenuHint>}</DropdownMenuSubContent></DropdownMenuSub>
    <DropdownMenuSub><DropdownMenuSubTrigger className={itemClassName}><Network aria-hidden className={iconClassName} /><span className="min-w-0 flex-1">MCPs</span><span className="w-7 text-right text-[11px] tabular-nums text-[var(--app-muted)]">{runtimeResources?.mcpServers.length ?? ''}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className={cn('w-[288px]', subMenuClassName)}><MenuHint>{runtimeResources ? `${runtimeName} 当前会话` : '正在读取当前会话运行时'}</MenuHint>{runtimeResources?.mcpServers.length ? runtimeResources.mcpServers.map((server) => <DropdownMenuItem className={itemClassName} key={server.id} onClick={() => onInsertText?.(`本次任务如需项目数据，请使用当前会话已连接的 MCP「${server.name}」。`)}><Network aria-hidden className={iconClassName} /><span>{server.name}</span></DropdownMenuItem>) : <MenuHint>{runtimeResources ? '当前会话没有已连接的 MCP。' : '运行时尚未就绪。'}</MenuHint>}</DropdownMenuSubContent></DropdownMenuSub>
    <DropdownMenuSub><DropdownMenuSubTrigger className={itemClassName}><ShieldCheck aria-hidden className={iconClassName} /><span className="min-w-0 flex-1">权限</span><span className="w-14 text-right text-[11px] text-[var(--app-muted)]">{permissions === 'restricted' ? '受限' : permissions === 'ask' ? '询问' : permissions === 'open' ? '开放' : '加载中'}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className={cn('w-[220px]', subMenuClassName)}>{(['restricted', 'ask', 'open'] as AccessMode[]).map((mode) => <DropdownMenuItem className={itemClassName} key={mode} onClick={() => onAccessModeChange?.(mode)}><ShieldCheck aria-hidden className={cn(iconClassName, permissions === mode && 'text-[var(--app-brand)]')} /><span>{mode === 'restricted' ? '受限（只读）' : mode === 'ask' ? '询问（写操作确认）' : '开放（完全访问）'}</span></DropdownMenuItem>)}</DropdownMenuSubContent></DropdownMenuSub>
  </DropdownMenuContent></DropdownMenu><PluginDialog onInstall={onInstallPlugin} onOpenChange={setPluginsOpen} open={pluginsOpen} plugins={codexResources?.plugins ?? []} /></>
}

'use client'

import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { useState } from 'react'

interface AppWorkspaceProps {
  workspaceName: string
  nickname: string
  email: string
  avatarUrl: string | null
  initialPrompt: string
}

const primaryNavigation = [
  { label: '搜索', icon: '/openlink/app/search.svg' },
  { label: '首页', icon: '/openlink/app/home.svg', active: true },
  { label: '项目', icon: '/openlink/app/projects.svg' },
  { label: '库', icon: '/openlink/app/library.svg' },
  { label: '设计系统', icon: '/openlink/app/design-system.svg' },
  { label: '模板', icon: '/openlink/app/templates.svg' },
] as const

const recentChats = ['运行网站', 'New radix-nova project', 'Tooltip Provider 错误'] as const

function UserAvatar({ avatarUrl, nickname, size = 22 }: { avatarUrl: string | null; nickname: string; size?: number }) {
  const initial = nickname.trim().charAt(0).toUpperCase() || 'O'

  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,#7c3aed,#ec4899)] text-[10px] font-semibold text-white"
      style={{ width: size, height: size }}
    >
      {avatarUrl ? <img alt="" className="size-full object-cover" src={avatarUrl} /> : initial}
    </span>
  )
}

function SidebarItem({
  label,
  icon,
  active = false,
  collapsed,
}: {
  label: string
  icon: string
  active?: boolean
  collapsed: boolean
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`flex h-8 w-full items-center rounded-md text-sm tracking-[-0.1504px] transition-colors ${collapsed ? 'justify-center px-0' : 'gap-2 px-2'} ${active ? 'bg-[#1f1f1f] text-[#ededed]' : 'text-[#a0a0a0] hover:bg-[#121212] hover:text-[#ededed]'}`}
      title={collapsed ? label : undefined}
      type="button"
    >
      <img alt="" className="size-4 shrink-0" src={icon} />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  )
}

function Sidebar({
  collapsed,
  mobileOpen,
  onToggle,
  onCloseMobile,
  nickname,
  email,
  avatarUrl,
}: {
  collapsed: boolean
  mobileOpen: boolean
  onToggle: () => void
  onCloseMobile: () => void
  nickname: string
  email: string
  avatarUrl: string | null
}) {
  return (
    <>
      {mobileOpen && <button aria-label="关闭侧边栏" className="fixed inset-0 z-30 bg-black/70 md:hidden" onClick={onCloseMobile} type="button" />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col overflow-hidden border-r bg-black transition-[width,transform,border-color] duration-200 md:relative md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} ${collapsed ? 'w-[280px] border-[#1a1a1a] md:w-0 md:border-transparent' : 'w-[280px] border-[#1a1a1a]'}`}
      >
        <div className="flex flex-col gap-3 py-2">
          <div className={`flex h-8 items-center gap-1 px-2 ${collapsed ? 'md:justify-center' : ''}`}>
            <button className={`flex h-8 min-w-0 flex-1 items-center rounded-md border border-transparent pl-1.5 hover:bg-[#121212] ${collapsed ? 'md:flex-none md:p-0' : ''}`} type="button">
              <UserAvatar avatarUrl={avatarUrl} nickname={nickname} />
              {!collapsed && (
                <>
                  <span className="ml-1.5 min-w-0 flex-1 truncate text-left text-sm font-medium tracking-[-0.1504px] text-[#ededed]">个人</span>
                  <img alt="" className="mx-1 size-4" src="/openlink/app/scope-switcher.svg" />
                </>
              )}
            </button>
            <button aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'} className={`flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-[#121212] ${collapsed ? 'md:hidden' : ''}`} onClick={onToggle} type="button">
              <img alt="" className="size-4" src="/openlink/app/sidebar-toggle.svg" />
            </button>
          </div>

          <div className="px-2">
            <button className={`flex h-8 w-full items-center rounded-md bg-[#121212] text-sm font-medium tracking-[-0.1504px] text-[#ededed] ${collapsed ? 'justify-center px-0' : 'justify-center pl-7 pr-2'}`} title={collapsed ? '新建聊天' : undefined} type="button">
              {collapsed ? <span className="text-lg leading-none">＋</span> : <><span className="flex-1">新建聊天</span><img alt="" className="size-4" src="/openlink/app/new-chat-chevron.svg" /></>}
            </button>
          </div>

          <nav aria-label="工作区导航" className="flex flex-col gap-0.5 px-2">
            {primaryNavigation.map((item) => <SidebarItem collapsed={collapsed} key={item.label} {...item} />)}
          </nav>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <section>
            {!collapsed && (
              <div className="flex h-[30px] items-start justify-between px-2 text-[13px] font-medium tracking-[-0.0762px] text-[#a0a0a0]">
                <span>收藏</span><img alt="" className="size-4 rotate-90" src="/openlink/app/section-chevron.svg" />
              </div>
            )}
            <SidebarItem collapsed={collapsed} icon="/openlink/app/chat.svg" label="AI Elements 集成" />
          </section>

          <section className="mt-5">
            {!collapsed && (
              <div className="flex h-[30px] items-start justify-between px-2 text-[13px] font-medium tracking-[-0.0762px] text-[#a0a0a0]">
                <span>最近聊天</span><img alt="" className="size-4 rotate-90" src="/openlink/app/section-chevron.svg" />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              {recentChats.map((chat) => <SidebarItem collapsed={collapsed} icon="/openlink/app/chat.svg" key={chat} label={chat} />)}
            </div>
          </section>
        </div>

        <div className={`flex h-12 shrink-0 items-end gap-1 px-2 pb-3 ${collapsed ? 'md:justify-center' : ''}`}>
          <button className={`flex h-9 min-w-0 flex-1 items-center rounded-md py-0.5 hover:bg-[#121212] ${collapsed ? 'justify-center px-0' : 'gap-2 px-2.5'}`} title={email} type="button">
            <UserAvatar avatarUrl={avatarUrl} nickname={nickname} size={20} />
            {!collapsed && <span className="min-w-0 flex-1 truncate text-left text-sm tracking-[-0.1504px] text-[#ededed]">{email}</span>}
          </button>
          {!collapsed && <button className="flex h-9 items-center justify-center rounded-md border border-[#27272a] bg-[#0a0a0a] px-3 text-sm font-medium text-[#ededed]" type="button">$5</button>}
        </div>
      </aside>
    </>
  )
}

function WorkspacePrompt({ initialPrompt }: { initialPrompt: string }) {
  const [input, setInput] = useState(initialPrompt)

  return (
    <PromptInput
      className="w-full max-w-[690px] [&>[data-slot=input-group]]:h-[108px] [&>[data-slot=input-group]]:min-h-[108px] [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:border-[#404040] [&>[data-slot=input-group]]:bg-[#121212] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:focus-within:border-[#5b5b5b] [&>[data-slot=input-group]]:focus-within:ring-0"
      onSubmit={() => setInput('')}
    >
      <PromptInputBody>
        <PromptInputTextarea
          aria-label="描述你想创建的内容"
          className="min-h-[54px]! px-3 pt-3 text-[15px] text-[#ededed] placeholder:text-[#666]"
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder=""
          value={input}
        />
      </PromptInputBody>
      <PromptInputFooter className="h-10 px-3 pb-3">
        <PromptInputTools className="gap-0.5">
          <PromptInputButton aria-label="添加附件" className="size-7 rounded-md p-0 hover:bg-[#202020]" type="button">
            <img alt="" className="size-4" src="/openlink/app/plus.svg" />
          </PromptInputButton>
          <PromptInputButton className="h-7 max-w-[200px] gap-1 rounded-md px-1.5 text-[13px] font-medium text-[#a0a0a0] hover:bg-[#202020] hover:text-[#ededed]" type="button">
            <img alt="" className="size-4" src="/openlink/model.svg" />
            <span>Fable 5</span>
            <img alt="" className="size-4" src="/openlink/app/prompt-chevron.svg" />
          </PromptInputButton>
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <PromptInputButton className="h-7 gap-1 rounded-lg px-2 text-[13px] font-medium text-[#a0a0a0] hover:bg-[#202020] hover:text-[#ededed]" type="button">
            <span>Project</span>
            <img alt="" className="size-3" src="/openlink/app/project-chevron.svg" />
          </PromptInputButton>
          <PromptInputSubmit aria-label="发送" className="size-7 rounded-md border border-[#ededed] bg-[#ededed] p-0 hover:bg-white">
            <img alt="" className="size-4" src="/openlink/app/mic.svg" />
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
  )
}

export function AppWorkspace({ workspaceName, nickname, email, avatarUrl, initialPrompt }: AppWorkspaceProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="openlink-app-shell flex h-dvh min-h-[500px] overflow-hidden bg-black text-[#ededed]">
      <Sidebar
        avatarUrl={avatarUrl}
        collapsed={collapsed}
        email={email}
        mobileOpen={mobileOpen}
        nickname={nickname}
        onCloseMobile={() => setMobileOpen(false)}
        onToggle={() => {
          if (mobileOpen) {
            setMobileOpen(false)
            setCollapsed(true)
          } else {
            setCollapsed((value) => !value)
          }
        }}
      />
      <main className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black px-6">
        <header className="absolute inset-x-0 top-0 flex h-12 items-center border-b border-[#1a1a1a] px-3 md:border-transparent">
          <button aria-label="打开侧边栏" className="flex size-8 items-center justify-center rounded-md hover:bg-[#121212] md:hidden" onClick={() => { setCollapsed(false); setMobileOpen(true) }} type="button">
            <span className="flex w-4 flex-col gap-1"><i className="h-px w-4 bg-[#a0a0a0]" /><i className="h-px w-4 bg-[#a0a0a0]" /><i className="h-px w-4 bg-[#a0a0a0]" /></span>
          </button>
          <span className="ml-2 truncate text-sm font-medium text-[#ededed] md:hidden">{workspaceName}</span>
          {collapsed && (
            <button aria-label="展开侧边栏" className="hidden size-8 items-center justify-center rounded-md hover:bg-[#121212] md:flex" onClick={() => setCollapsed(false)} type="button">
              <img alt="" className="size-4" src="/openlink/app/sidebar-expand.svg" />
            </button>
          )}
        </header>
        <div className="flex w-full justify-center">
          <WorkspacePrompt initialPrompt={initialPrompt} />
        </div>
      </main>
    </div>
  )
}

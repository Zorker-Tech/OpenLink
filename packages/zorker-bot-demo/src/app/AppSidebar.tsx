import { AgentAvatar } from '../components/AgentAvatar'
import { PlusIcon, SearchIcon } from '../components/icons'
import { sessionToAgent, type AppSession } from './data'

export type AppSidebarRow = {
  session: AppSession
  name: string
  preview: string
  time: string
  unread?: boolean
}

export type AppSidebarProps = {
  rows: AppSidebarRow[]
  activeId: string
  collapsed: boolean
  search: string
  assetBase: string
  onSearch: (value: string) => void
  onSearchFocus: () => void
  onSelect: (sessionId: string) => void
  onNewAgent: () => void
}

export function AppSidebar({
  rows,
  activeId,
  collapsed,
  search,
  assetBase,
  onSearch,
  onSearchFocus,
  onSelect,
  onNewAgent,
}: AppSidebarProps) {
  return (
    <aside
      className="zbd-sidebar zbd-app-sidebar"
      data-collapsed={collapsed ? '' : undefined}
    >
      {collapsed ? (
        <div className="zbd-sidebar-collapsed-top" />
      ) : (
        <>
          <div className="zbd-sidebar-header">
            <div className="zbd-sidebar-header-lead">
              <span className="zbd-traffic-spacer" />
            </div>
            <div className="zbd-sidebar-header-actions">
              <button
                aria-label="New agent"
                className="zbd-icon-button"
                onClick={onNewAgent}
                title="New agent"
                type="button"
              >
                <PlusIcon size={14} />
              </button>
            </div>
          </div>
          <label className="zbd-search zbd-app-search">
            <SearchIcon size={14} />
            <input
              aria-label="Search chats"
              className="zbd-search-input"
              onFocus={onSearchFocus}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search"
              type="search"
              value={search}
            />
          </label>
        </>
      )}
      <div className="zbd-sidebar-list">
        {rows.map(({ session, name, preview, time, unread }) => {
          const isActive = session.id === activeId
          const agent = sessionToAgent(session, name)
          return (
            <button
              className="zbd-agent-row zbd-app-agent-row"
              data-active={isActive ? '' : undefined}
              key={session.id}
              onClick={() => onSelect(session.id)}
              title={name}
              type="button"
            >
              <span className="zbd-agent-row-avatar">
                <AgentAvatar
                  agent={agent}
                  assetBase={assetBase}
                  className={
                    session.isDraft ? 'zbd-app-avatar-new' : undefined
                  }
                  size={32}
                />
                {unread ? <span className="zbd-unread-dot" /> : null}
              </span>
              {collapsed ? null : (
                <span className="zbd-agent-row-body">
                  <span className="zbd-agent-row-top">
                    <span className="zbd-agent-row-name">{name}</span>
                    <span className="zbd-agent-row-time">{time}</span>
                  </span>
                  <span className="zbd-agent-row-preview">
                    {preview || 'No messages yet'}
                  </span>
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="zbd-sidebar-footer">
        {collapsed ? (
          <>
            <button
              aria-label="New agent"
              className="zbd-sidebar-footer-action"
              onClick={onNewAgent}
              type="button"
            >
              <PlusIcon size={15} />
            </button>
            <span className="zbd-viewer-avatar">AS</span>
          </>
        ) : (
          <>
            <span className="zbd-viewer-avatar">AS</span>
            <span className="zbd-viewer-name">Armand Segall</span>
          </>
        )}
      </div>
    </aside>
  )
}

import { AGENTS } from '../data/agents'
import { AgentAvatar } from './AgentAvatar'
import { PlusIcon, SearchIcon } from './icons'

export type SidebarProps = {
  collapsed: boolean
  activeAgentName: string
  activePreview: string
  activeTime: string
  assetBase: string
}

export function Sidebar({
  collapsed,
  activeAgentName,
  activePreview,
  activeTime,
  assetBase,
}: SidebarProps) {
  return (
    <aside className="zbd-sidebar" data-collapsed={collapsed ? '' : undefined}>
      {collapsed ? (
        <div className="zbd-sidebar-collapsed-top" />
      ) : (
        <>
          <div className="zbd-sidebar-header">
            <div className="zbd-sidebar-header-lead">
              <span className="zbd-traffic-spacer" />
            </div>
            <div className="zbd-sidebar-header-actions">
              <button aria-label="New agent" className="zbd-icon-button" type="button">
                <PlusIcon size={14} />
              </button>
            </div>
          </div>
          <label className="zbd-search">
            <SearchIcon size={14} />
            <input aria-label="Search chats" className="zbd-search-input" placeholder="Search" type="search" />
          </label>
        </>
      )}
      <div className="zbd-sidebar-list">
        {AGENTS.map((agent) => {
          const isActive = agent.id === 'sales-outbound'
          const name = isActive ? activeAgentName : agent.name
          const preview = isActive ? activePreview : agent.preview
          const time = isActive ? activeTime : agent.timeLabel

          return (
            <button
              className="zbd-agent-row"
              data-active={isActive ? '' : undefined}
              key={agent.id}
              title={name}
              type="button"
            >
              <span className="zbd-agent-row-avatar">
                <AgentAvatar agent={{ ...agent, name }} assetBase={assetBase} size={32} />
                {agent.unread ? <span className="zbd-unread-dot" /> : null}
              </span>
              {collapsed ? null : (
                <span className="zbd-agent-row-body">
                  <span className="zbd-agent-row-top">
                    <span className="zbd-agent-row-name">{name}</span>
                    <span className="zbd-agent-row-time">{time}</span>
                  </span>
                  <span className="zbd-agent-row-preview">{preview}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="zbd-sidebar-footer">
        {collapsed ? (
          <>
            <button aria-label="New agent" className="zbd-sidebar-footer-action" type="button">
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

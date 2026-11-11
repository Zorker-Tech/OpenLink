import { useRef } from 'react'
import { useAutoScroll } from '../hooks/useAutoScroll'
import type { useDemoSequence } from '../hooks/useDemoSequence'
import type { Agent } from '../types'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { DemoCursor } from './DemoCursor'
import { ScreenOverlay } from './ScreenOverlay'
import { Sidebar } from './Sidebar'
import { SidePane } from './SidePane'
import { TrafficLights } from './TrafficLights'
import { Transcript } from './Transcript'

export type ZorkerBotWindowProps = {
  demo: ReturnType<typeof useDemoSequence>
  rootSize: { width: number; height: number }
  assetBase: string
}

export function ZorkerBotWindow({ demo, rootSize, assetBase }: ZorkerBotWindowProps) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  useAutoScroll(transcriptRef, [demo.transcript, demo.pending])

  const sidebarWidth = demo.sidePaneOpen ? 68 : 280
  const activeAgent: Agent = { ...demo.activeAgent, name: demo.agentName }

  return (
    <div className="zbd-root" data-theme="cursor-light">
      <div className="zbd-shell">
        <TrafficLights />
        <div
          className="zbd-sidebar-slot"
          style={{
            width: sidebarWidth,
            transition: 'width .45s cubic-bezier(.22,1,.36,1)',
          }}
        >
          <Sidebar
            activeAgentName={demo.agentName}
            activePreview={demo.agentPreview}
            activeTime={demo.agentTime}
            assetBase={assetBase}
            collapsed={demo.sidePaneOpen}
          />
        </div>
        <div className="zbd-chat">
          <div className="zbd-chat-header-wrap">
            <ChatHeader
              agent={activeAgent}
              assetBase={assetBase}
              computerOpen={demo.sidePaneOpen}
              onToggleComputer={demo.toggleComputer}
            />
          </div>
          <Transcript
            assetBase={assetBase}
            cardStatus={demo.cardStatus}
            entries={demo.transcript}
            onFinishComputer={demo.finishTakeOver}
            onOpenComputer={() => demo.openScreen('entry')}
            onTakeOver={demo.takeOver}
            pending={demo.pending}
            screen={demo.screen}
            transcriptRef={transcriptRef}
          />
          <Composer agentName={demo.agentName} />
        </div>
        {demo.sidePaneOpen ? (
          <SidePane
            assetBase={assetBase}
            onClose={demo.closeComputer}
            onOpenScreen={() => demo.openScreen('pane')}
            screen={demo.screen}
          />
        ) : null}
        {demo.overlay ? (
          <ScreenOverlay
            assetBase={assetBase}
            onClose={demo.closeScreen}
            onFinish={demo.finishTakeOver}
            overlay={demo.overlay}
            rootHeight={rootSize.height}
            rootWidth={rootSize.width}
            screen={demo.screen}
          />
        ) : null}
        <DemoCursor cursor={demo.cursor} ripples={demo.ripples} />
      </div>
    </div>
  )
}

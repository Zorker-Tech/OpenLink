'use client'

import { useState } from 'react'
import { ZorkerBotDemo } from '../ZorkerBotDemo'
import '../styles/zorker-bot-demo.css'

export function ZorkerBotDemoPage({ runtimeLabel }: { runtimeLabel?: string }) {
  const [runKey, setRunKey] = useState(0)

  return (
    <main className="zbd-demo-page">
      <div className="zbd-demo-page-glow" aria-hidden="true" />
      <header className="zbd-demo-page-header">
        <div className="zbd-demo-wordmark">
          <span className="zbd-demo-wordmark-mark" aria-hidden="true">
            <img alt="" src="/zorker-bot-demo/avatars/header.svg" />
          </span>
          <span>Zorker Bot</span>
        </div>
        <div className="zbd-demo-page-meta">
          {runtimeLabel ? <span className="zbd-demo-runtime">{runtimeLabel}</span> : null}
          <button className="zbd-demo-replay" onClick={() => setRunKey((value) => value + 1)} type="button">
            Replay demo
          </button>
        </div>
      </header>
      <div className="zbd-demo-page-copy">
        <p className="zbd-demo-eyebrow">Always-on AI teammates</p>
        <h1>Zorker Bot gets the work done.</h1>
        <p>Give a Bot a real task. It can work across your tools, handle the details, and bring back a finished result.</p>
      </div>
      <div className="zbd-demo-stage-shell">
        <ZorkerBotDemo key={runKey} />
      </div>
      <p className="zbd-demo-footnote">
        Zorker Bot · auto-playing demo · click Replay to restart
      </p>
    </main>
  )
}

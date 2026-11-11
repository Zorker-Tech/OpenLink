import type { Metadata } from 'next'
import { ZorkerBotDemoPage } from '@zorker/bot-demo/website'

export const metadata: Metadata = {
  title: 'Zorker Bot hero demo — Next.js',
  description: 'A 1:1 React reconstruction of the Zorker Bot hero demo.',
}

export default function ZorkerBotDemoRoute() {
  return <ZorkerBotDemoPage runtimeLabel="Next.js" />
}

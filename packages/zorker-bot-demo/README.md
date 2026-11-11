# @zorker/bot-demo

A component-level reconstruction of the Zorker Bot hero demo. The package is split into
small, composable modules so the full demo can be embedded as-is or individual
pieces can be reused in another React application.

## Entry points

- `@zorker/bot-demo` — the demo component, primitives, hooks, data, and types.
- `@zorker/bot-demo/website` — a website-ready page wrapper with the hero
  copy and a replay control.
- `@zorker/bot-demo/app` — the full-window application shell with the complete
  session list, transcript interactions, computer pane, and command palette.
- `@zorker/bot-demo/styles.css` — the scoped stylesheet.

## Standalone application

`demo/zorker-bot-vite` runs the full-window app as a standalone page rather
than the embedded hero preview. From the repository root:

```sh
npm run demo:zorker-bot:vite
```

Open `http://localhost:4173`. To produce the production bundle:

```sh
npm run demo:zorker-bot:vite:build
```

The built app is written to `demo/zorker-bot-vite/dist`.

## Raw component

```tsx
import { ZorkerBotDemo } from '@zorker/bot-demo'
import '@zorker/bot-demo/styles.css'

export function Hero() {
  return <ZorkerBotDemo assetBase="/zorker-bot-demo" />
}
```

`assetBase` must point at a public directory containing:

```
zorker-bot-demo/
  avatars/*.svg
  wallpaper-light.webp
  wallpaper-dark.webp
```

The `public/zorker-bot-demo` directory in this repository is the canonical copy.
Run `npm run build` in the package directory before packing or installing it in
another application. The package build emits JavaScript and declarations under
`dist`; the host application still serves the demo's public assets at `assetBase`.

## Website wrapper

```tsx
import { ZorkerBotDemoPage } from '@zorker/bot-demo/website'

export default function Page() {
  return <ZorkerBotDemoPage runtimeLabel="Next.js" />
}
```

The website wrapper is intentionally kept in `src/website` so a marketing site can
depend on the page-level composition without pulling in the raw demo orchestration
from its own source tree.

## Composition

The main pieces are exported independently:

- `ZorkerBotWindow` — the app-window composition (sidebar, chat, side pane, overlay).
- `Sidebar`, `ChatHeader`, `Composer`, `Transcript`
- `MessageBubble`, `PendingRow`, `ComputerCard`, `SystemEntry`
- `RemoteDesktop`, `LoginView`, `PortalView`, `Dock`
- `ScreenOverlay`, `ScreenFrame`, `DemoCursor`
- `useDemoSequence`, `useCursor`, `useStageScale`

Consumers that only need the app window can import `ZorkerBotWindow` and provide
their own state, or use `useDemoSequence` with a custom transcript.

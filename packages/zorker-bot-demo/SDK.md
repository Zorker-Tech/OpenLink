# OpenLink Demo SDK

`OpenLinkDemo` is a React 19 component for embedding the OpenLink Bot workspace in an existing site. It demonstrates computer takeover, multi-Bot collaboration with approval, and scheduled routines. The workspace uses sample data and runs entirely in the browser.

## Build and install

From the OpenLink repository:

```sh
npm run demo:openlink:sdk
npm pack ./packages/zorker-bot-demo/dist-sdk
```

In the Next.js website:

```sh
npm install /path/to/zorker-openlink-demo-0.1.0.tgz
```

## Next.js App Router

Import the component and stylesheet in the existing page or layout segment where the demo belongs. The demo supports server rendering and has its own client boundary. The available width of its parent controls the layout.

```tsx
import { OpenLinkDemo } from '@zorker/openlink-demo'
import '@zorker/openlink-demo/styles.css'

export default function ProductPage() {
  return (
    <main>
      <h1>OpenLink Bot</h1>
      <OpenLinkDemo initialScenario="computer" theme="auto" />
    </main>
  )
}
```

With the Pages Router, put the stylesheet import in `pages/_app.tsx`. Copying public assets and configuring a Next.js route are unnecessary.

| Prop | Values | Default |
| --- | --- | --- |
| `initialScenario` | `"computer"`, `"team"`, `"routine"` | `"computer"` |
| `theme` | `"light"`, `"dark"`, `"auto"` | `"auto"` (system preference) |
| `className` | Host-supplied CSS class on the root | — |

Use **Play demo** to start the selected scenario. After a run completes, the composer accepts sample follow-up messages. Switching scenarios or selecting **Reset demo** clears that run. The app-level search shortcut responds while focus is inside its workspace.

## Compose a custom demo

The same package exports `OpenLinkAppShell` and `OpenLinkNavigationRail` for layout and navigation, and `AppTranscript`, `AppComposer`, `AppCommandPalette`, `ActivityCard`, `ConfirmationCard`, and `SystemEntry` for the Bot UI. These components take state and callbacks from the host. If composing custom scenes, supply avatar URLs and any assets referenced by the chosen timeline entries.

Within this repository, the homepage uses the source entry `@zorker/bot-demo/embed` and the stylesheet `@zorker/bot-demo/embed.css`. The addressable SDK package built by the command above is `@zorker/openlink-demo`.

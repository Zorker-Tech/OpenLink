import type { Preview } from "@storybook/nextjs-vite"
import { useEffect, type ReactNode } from "react"

import { OpenLinkThemeProvider } from "@/components/ui/theme-scope"
import "@/app/globals.css"
import "../stories/storybook.css"
import { installLocalApi } from './local-api'

type Theme = "light" | "dark"

function ThemeFrame({ children, theme }: { children: ReactNode; theme: Theme }) {
  useEffect(() => {
    document.documentElement.classList.remove("light", "dark")
    document.documentElement.classList.add(theme)
    document.documentElement.style.colorScheme = theme
  }, [theme])

  return (
    <OpenLinkThemeProvider theme={theme}>
      <div
        className="openlink-story-frame min-h-screen bg-background text-foreground"
        data-openlink-theme={theme}
      >
        {children}
      </div>
    </OpenLinkThemeProvider>
  )
}

const preview: Preview = {
  beforeEach: context => context.parameters.localApi ? installLocalApi(context.parameters.localApi) : undefined,
  decorators: [
    (Story, context) => (
      <ThemeFrame theme={context.globals.theme as Theme}>
        <Story />
      </ThemeFrame>
    ),
  ],
  globalTypes: {
    theme: {
      description: "OpenLink color theme",
      toolbar: {
        icon: "paintbrush",
        items: [
          { icon: "sun", title: "Light", value: "light" },
          { icon: "moon", title: "Dark", value: "dark" },
        ],
      },
    },
  },
  initialGlobals: {
    theme: "light",
  },
  parameters: {
    a11y: { test: "todo" },
    backgrounds: { disable: true },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
      expanded: true,
    },
    docs: { source: { state: "open" } },
    layout: "centered",
    options: {
      storySort: {
        order: ["Start Here", "Foundations", "UI", "AI Elements", "Product"],
      },
    },
  },
  tags: ["autodocs", "test"],
}

export default preview

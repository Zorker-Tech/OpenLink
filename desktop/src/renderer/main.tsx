import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles.css'

import { DesktopApp, DesktopError } from './app'
import { fetchCapabilities, installRuntimeMeta } from './platform/api'
import { loadInitialMessages } from './providers'

async function bootstrap() {
  const root = createRoot(document.getElementById('root')!)

  try {
    const capabilities = await fetchCapabilities()
    installRuntimeMeta(capabilities.publicConfig)
    const { locale, messages } = await loadInitialMessages()
    document.documentElement.lang = locale
    root.render(
      <StrictMode>
        <DesktopApp capabilities={capabilities} locale={locale} messages={messages} />
      </StrictMode>,
    )
  } catch (error) {
    root.render(
      <StrictMode>
        <DesktopError
          detail={error instanceof Error ? error.message : undefined}
          title="This OpenLink instance is not compatible with the desktop client"
        />
      </StrictMode>,
    )
  }
}

void bootstrap()

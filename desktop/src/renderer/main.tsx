import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles.css'

import { DesktopApp } from './app'
import { fetchCapabilities, installRuntimeMeta } from './platform/api'
import { loadInitialMessages } from './providers'
import { DesktopStartupError } from './startup-error'

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
        <DesktopStartupError error={error} />
      </StrictMode>,
    )
  }
}

void bootstrap()

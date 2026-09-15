import type { BrowserAgentSession } from './browser-client.js'
import type { BrowserAgentBinding } from './contracts.js'
import type { ProjectRuntimeDescriptor } from './project-runtime.js'

/** Paths are part of the immutable worker image, not user-controlled input. */
export const LOCAL_BROWSER_EXTENSION_PATH = '/opt/openlink/agent-worker/extensions/openlink-browser.ts'
export const REMOTE_BROWSER_EXTENSION_PATH = '/opt/openlink/agent-rpc-worker/extensions/openlink-browser.ts'

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
}

export function projectBrowserHostOrigin(projectRuntime: ProjectRuntimeDescriptor): string {
  const url = new URL(projectRuntime.browserHostEndpoint)
  if (isLoopback(url.hostname)) url.hostname = 'host.containers.internal'
  return url.origin
}

/**
 * Convert Browser Host's events URL to the REST origin used by the Pi
 * extension. Project session containers reach the Project VM's published
 * service ports through the Podman host gateway, not their own loopback.
 */
export function browserHostOrigin(session: BrowserAgentSession, projectRuntime?: ProjectRuntimeDescriptor): string {
  const url = new URL(session.connection.eventsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  if (projectRuntime && isLoopback(url.hostname)) url.hostname = 'host.containers.internal'
  return url.origin
}

export function browserAgentBinding(
  session: BrowserAgentSession,
  extensionPath: string,
  projectRuntime?: ProjectRuntimeDescriptor,
): BrowserAgentBinding {
  return {
    hostUrl: browserHostOrigin(session, projectRuntime),
    sessionId: session.state.id,
    controlToken: session.controlToken,
    extensionPath,
  }
}

export function browserHostNetworkTarget(hostUrl: string): string {
  return new URL(hostUrl).hostname
}

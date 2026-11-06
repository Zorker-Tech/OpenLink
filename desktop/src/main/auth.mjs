import { createServer } from 'node:http'

const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function successPage() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>OpenLink</title></head><body style="font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0b0b0c;color:#f4f4f5"><div style="text-align:center"><h1 style="font-size:20px">Signed in</h1><p style="color:#a1a1aa">You can close this window and return to OpenLink.</p></div></body></html>'
}

function failurePage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>OpenLink</title></head><body style="font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0b0b0c;color:#f4f4f5"><div style="text-align:center"><h1 style="font-size:20px">Sign-in failed</h1><p style="color:#a1a1aa">${message}</p></div></body></html>`
}

/**
 * Desktop OAuth broker.
 *
 * The system browser performs the identity-provider flow and returns to a
 * one-shot loopback listener owned by the Electron main process. The renderer
 * receives only the authorization code and completes the PKCE exchange with
 * the platform SDK. No token ever crosses the browser boundary.
 */
export function createDesktopAuth({ openExternal, logger = console } = {}) {
  if (typeof openExternal !== 'function') {
    throw new Error('createDesktopAuth requires an openExternal transport')
  }
  let active = null

  async function hydite({ authorizationUrl, redirectUri, state, timeoutMs = 300_000 } = {}) {
    if (active) throw new Error('Another desktop sign-in is already in progress')
    if (typeof authorizationUrl !== 'string') throw new Error('A Hydite authorization URL is required')
    let authorization
    try {
      authorization = new URL(authorizationUrl)
    } catch {
      throw new Error('The Hydite authorization URL is invalid')
    }
    if (!['https:', 'http:'].includes(authorization.protocol) || authorization.username || authorization.password) {
      throw new Error('The Hydite authorization URL must be credential-free HTTP or HTTPS')
    }

    let redirect
    try {
      redirect = new URL(redirectUri)
    } catch {
      throw new Error('The desktop redirect URI is invalid')
    }
    if (
      redirect.protocol !== 'http:' ||
      !LOOPBACK_HOSTS.has(redirect.hostname) ||
      !redirect.port ||
      redirect.pathname !== '/auth/hydite/callback'
    ) {
      throw new Error('The desktop redirect URI must be a loopback /auth/hydite/callback URL')
    }
    if (typeof state !== 'string' || !STATE_PATTERN.test(state)) {
      throw new Error('The OAuth state value is invalid')
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const server = createServer((request, response) => {
        let target
        try {
          target = new URL(request.url || '/', `http://${request.headers.host}`)
        } catch {
          response.writeHead(400, { connection: 'close' }).end()
          return
        }
        if (target.pathname !== redirect.pathname) {
          response.writeHead(404, { connection: 'close' }).end()
          return
        }
        const receivedState = target.searchParams.get('state')
        const code = target.searchParams.get('code')
        const providerError = target.searchParams.get('error')
        if (receivedState !== state) {
          response.writeHead(400, { connection: 'close', 'content-type': 'text/html; charset=utf-8' }).end(failurePage('The sign-in response did not match this request.'))
          finish(new Error('Hydite returned an invalid state'))
          return
        }
        if (providerError || !code) {
          response.writeHead(400, { connection: 'close', 'content-type': 'text/html; charset=utf-8' }).end(failurePage('The identity provider rejected the sign-in request.'))
          finish(new Error(providerError ? `Hydite sign-in failed: ${providerError}` : 'Hydite did not return an authorization code'))
          return
        }
        response.writeHead(200, { connection: 'close', 'content-type': 'text/html; charset=utf-8' }).end(successPage())
        finish(null, { code })
      })

      const timer = setTimeout(() => finish(new Error('Hydite sign-in timed out')), timeoutMs)
      timer.unref?.()

      function finish(error, result) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        active = null
        setTimeout(() => {
          server.close()
          server.closeAllConnections?.()
        }, 100).unref?.()
        if (error) reject(error)
        else resolve(result)
      }

      server.once('error', (error) => finish(error))
      active = { cancel: () => finish(new Error('Sign-in was cancelled')) }
      server.listen(Number(redirect.port), '127.0.0.1', () => {
        logger.info?.(`[desktop-auth] waiting for Hydite callback on ${redirect.origin}${redirect.pathname}`)
        Promise.resolve(openExternal(authorization.href)).catch((error) => {
          finish(error instanceof Error ? error : new Error('Unable to open the system browser'))
        })
      })
    })
  }

  function cancel() {
    active?.cancel?.()
  }

  return { hydite, cancel }
}

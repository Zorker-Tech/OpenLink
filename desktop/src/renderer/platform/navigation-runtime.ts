const listeners = new Set<(path: string) => void>()

/** Set by the desktop router so action wrappers can follow server redirects. */
export function setDesktopNavigator(navigate: ((path: string) => void) | null) {
  if (navigate) listeners.add(navigate)
  else listeners.clear()
}

/** Navigate from non-React code (action wrappers, auth callbacks). */
export function navigateDesktop(path: string) {
  if (!path) return
  for (const listener of listeners) {
    listener(path)
    return
  }
  window.location.assign(path)
}

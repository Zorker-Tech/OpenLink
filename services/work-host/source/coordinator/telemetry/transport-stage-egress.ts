/** Dispatch reports without allowing slow control-port calls to grow without bound. */
export function createBoundedReportForwarder(maximumInFlight: number) {
  let activeReports = 0

  return (dispatch: () => Promise<unknown>): void => {
    if (activeReports >= maximumInFlight) return
    activeReports += 1

    const release = () => { activeReports -= 1 }
    try {
      void dispatch().then(release, release)
    } catch {
      release()
    }
  }
}

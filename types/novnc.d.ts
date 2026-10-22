declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean })

    background: string
    focusOnClick: boolean
    resizeSession: boolean
    scaleViewport: boolean

    disconnect(): void
  }
}

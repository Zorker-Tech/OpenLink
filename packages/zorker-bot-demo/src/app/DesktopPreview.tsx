export type DesktopPreviewProps = {
  assetBase: string
  className?: string
}

export function DesktopPreview({
  assetBase,
  className,
}: DesktopPreviewProps) {
  return (
    <div className={`zbd-app-desktop ${className ?? ''}`}>
      <img
        alt=""
        className="zbd-app-desktop-wallpaper"
        draggable={false}
        src={`${assetBase}/wallpaper-light.webp`}
      />
      <div className="zbd-app-desktop-window zbd-app-desktop-terminal">
        <div className="zbd-app-desktop-titlebar">
          <span />
          <span />
          <span />
        </div>
        <div className="zbd-app-desktop-terminal-body">
          <p>
            <span className="zbd-app-desktop-prompt">$</span> npm run dev
          </p>
          <p>ready - started on 0.0.0.0:3000</p>
          <p className="zbd-app-desktop-success">✓ compiled in 1.2s</p>
          <p>○ compiling /dashboard...</p>
          <p className="zbd-app-desktop-success">✓ compiled in 340ms</p>
        </div>
      </div>
      <div className="zbd-app-desktop-window zbd-app-desktop-browser">
        <div className="zbd-app-desktop-browserbar">
          <span />
          <span />
          <span />
          <span className="zbd-app-desktop-address" />
        </div>
        <div className="zbd-app-desktop-browser-body">
          <span className="zbd-app-desktop-browser-title" />
          <span className="zbd-app-desktop-browser-line" />
          <span className="zbd-app-desktop-browser-line" />
          <span className="zbd-app-desktop-browser-line is-short" />
          <span className="zbd-app-desktop-browser-card" />
          <span className="zbd-app-desktop-browser-card is-second" />
        </div>
      </div>
      <div className="zbd-app-desktop-dock">
        <span className="zbd-app-desktop-dock-item zbd-app-desktop-dock-terminal">
          <span>&gt;_</span>
        </span>
        <span className="zbd-app-desktop-dock-item zbd-app-desktop-dock-browser">
          <span />
        </span>
      </div>
    </div>
  )
}

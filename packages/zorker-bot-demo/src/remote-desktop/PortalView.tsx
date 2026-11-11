import { SkeletonBar } from './SkeletonBar'

const PORTAL_ROWS = [
  { check: false, first: 86, second: 70 },
  { check: true, first: 68, second: 90 },
  { check: true, first: 80, second: 58 },
  { check: true, first: 58, second: 82 },
  { check: true, first: 88, second: 66 },
  { check: true, first: 66, second: 88 },
  { check: true, first: 76, second: 54 },
  { check: true, first: 62, second: 78 },
  { check: true, first: 82, second: 64 },
]

export function PortalView() {
  return (
    <div className="zbd-rd-portal">
      <div className="zbd-rd-sidebar">
        <div className="zbd-rd-sidebar-group">
          <SkeletonBar width="62%" opacity={0.09} />
          <SkeletonBar width="48%" opacity={0.09} />
          <SkeletonBar width="70%" opacity={0.09} />
        </div>
        <div className="zbd-rd-sidebar-group">
          <SkeletonBar width="54%" opacity={0.09} />
          <SkeletonBar width="66%" opacity={0.09} />
          <SkeletonBar width="44%" opacity={0.09} />
          <SkeletonBar width="58%" opacity={0.09} />
        </div>
      </div>
      <div className="zbd-rd-main">
        <div className="zbd-rd-toolbar">
          <SkeletonBar width="30%" opacity={0.16} />
          <span className="zbd-rd-toolbar-spacer" />
          <span
            className="zbd-rd-pill"
            style={{
              width: '13%',
              height: 7,
              background: 'color-mix(in srgb, var(--rd-fg) 5%, transparent)',
            }}
          />
          <span
            className="zbd-rd-pill"
            style={{
              width: '17%',
              height: 7,
              background: 'color-mix(in srgb, var(--rd-fg) 8%, transparent)',
            }}
          />
        </div>
        <div className="zbd-rd-columns">
          <span className="zbd-rd-column-spacer" />
          <span className="zbd-rd-column" style={{ width: 'calc(40% + 11px)' }}>
            <SkeletonBar width="45%" opacity={0.14} />
          </span>
          <span className="zbd-rd-column" style={{ width: '28%' }}>
            <SkeletonBar width="50%" opacity={0.14} />
          </span>
          <SkeletonBar width="11%" opacity={0.14} />
        </div>
        <div className="zbd-rd-rows">
          {PORTAL_ROWS.map((row, index) => (
            <div className="zbd-rd-row" key={index}>
              {row.check ? (
                <span className="zbd-rd-check">
                  <svg aria-hidden="true" fill="none" height="6" viewBox="0 0 12 12" width="6">
                    <circle cx="6" cy="6" opacity="0.4" r="5.25" stroke="currentColor" strokeWidth="0.75" />
                    <path
                      d="M3.75 6.25l1.6 1.6 2.9-3.4"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.25"
                    />
                  </svg>
                </span>
              ) : (
                <span className="zbd-rd-radio" />
              )}
              <span className="zbd-rd-row-dot" />
              <span className="zbd-rd-row-cell" style={{ width: '40%' }}>
                <SkeletonBar width={`${row.first}%`} opacity={0.1} />
              </span>
              <span className="zbd-rd-row-cell" style={{ width: '28%' }}>
                <SkeletonBar width={`${row.second}%`} opacity={0.06} />
              </span>
              <SkeletonBar width="11%" opacity={0.06} />
            </div>
          ))}
        </div>
        <div className="zbd-rd-footer">
          <span>52 accounts</span>
          <span>36 contacts</span>
        </div>
      </div>
    </div>
  )
}

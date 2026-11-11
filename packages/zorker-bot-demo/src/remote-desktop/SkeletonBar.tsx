export function SkeletonBar({
  width,
  opacity,
  height = 3,
}: {
  width: string | number
  opacity: number
  height?: number
}) {
  return (
    <span
      aria-hidden="true"
      className="zbd-rd-bar"
      style={{ width, height, opacity }}
    />
  )
}

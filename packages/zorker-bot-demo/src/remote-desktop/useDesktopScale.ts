import { useEffect, useRef, useState } from 'react'

export function useDesktopScale<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const update = () => setScale(Math.max(0.1, node.clientWidth / 360))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return { ref, scale }
}

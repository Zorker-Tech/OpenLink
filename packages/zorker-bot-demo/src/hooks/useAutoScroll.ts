import { useLayoutEffect, type RefObject } from 'react'

export function useAutoScroll(
  ref: RefObject<HTMLElement | null>,
  dependencies: unknown[],
) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    // The caller controls when the transcript should follow the latest entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)
}

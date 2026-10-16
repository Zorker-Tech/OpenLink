'use client'

import type { CSSProperties, PropsWithChildren } from 'react'
import { ONBOARDING_MOTION } from './onboarding-motion-tokens'

export function OnboardingEntrance({
  children,
  className = '',
}: PropsWithChildren<{ className?: string }>) {
  const style = {
    '--onboarding-enter-duration': ONBOARDING_MOTION.enterDuration,
    '--onboarding-enter-easing': ONBOARDING_MOTION.enterEasing,
  } as CSSProperties & {
    '--onboarding-enter-duration': string
    '--onboarding-enter-easing': string
  }

  return <div className={`onboarding-entrance ${className}`} style={style}>{children}</div>
}

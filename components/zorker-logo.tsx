import { cn } from '@/lib/utils'

type ZorkerLogoVariant = 'mark' | 'wordmark'

interface ZorkerLogoProps {
  className?: string
  label?: string
  variant?: ZorkerLogoVariant
}

const sources: Record<ZorkerLogoVariant, { dark: string; light: string }> = {
  mark: {
    dark: '/openlink/logos/zorker-logo-dark.svg',
    light: '/openlink/logos/zorker-logo-light.svg',
  },
  wordmark: {
    dark: '/openlink/logos/zorker-dark.svg',
    light: '/openlink/logos/zorker-light.svg',
  },
}

export function ZorkerLogo({
  className,
  label = 'Zorker',
  variant = 'mark',
}: ZorkerLogoProps) {
  const source = sources[variant]

  return (
    <span aria-label={label} className={cn('inline-flex shrink-0', className)} role="img">
      <img alt="" aria-hidden="true" className="size-full object-contain dark:hidden" src={source.dark} />
      <img alt="" aria-hidden="true" className="hidden size-full object-contain dark:block" src={source.light} />
    </span>
  )
}

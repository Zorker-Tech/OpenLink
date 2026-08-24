/**
 * Shared semantic class package for OpenLink surfaces.
 *
 * Theme decisions belong to CSS variables in `app/globals.css`; components
 * select a role here rather than embedding a light or dark colour value.
 * Keeping the complete class strings in this module also makes them visible
 * to Tailwind's static scanner.
 */
export const themeTokens = {
  canvas: 'bg-[var(--app-background)] text-[var(--app-foreground)]',
  surface: 'bg-[var(--app-surface)] text-[var(--app-foreground)]',
  elevated: 'bg-[var(--app-elevated)] text-[var(--app-foreground)]',
  editor: 'bg-[var(--app-editor-background)] text-[var(--app-foreground)]',
  active: 'bg-[var(--app-active)] text-[var(--app-foreground)]',
  selected: 'bg-[var(--app-selected)] text-[var(--app-foreground)]',
  subtleSurface: 'bg-[var(--app-subtle-surface)] text-[var(--app-foreground)]',
  muted: 'text-[var(--app-muted)]',
  subtle: 'text-[var(--app-subtle-foreground)]',
  border: 'border-[var(--app-control-border)]',
  softBorder: 'border-[var(--app-border)]',
  divider: 'bg-[var(--app-border)]',
  hover: 'hover:bg-[var(--app-hover)]',
  action: 'bg-[var(--app-submit-background)] text-[var(--app-submit-foreground)]',
  actionHover: 'hover:bg-[var(--app-submit-hover)]',
  critical: 'text-[var(--app-danger)]',
  criticalSurface: 'bg-[var(--app-danger-surface)]',
  positive: 'text-[var(--app-success)]',
  positiveSurface: 'bg-[var(--app-success-surface)]',
  warning: 'text-[var(--app-warning)]',
  warningSurface: 'bg-[var(--app-warning-surface)]',
  info: 'text-[var(--app-info)]',
  infoSurface: 'bg-[var(--app-info-surface)]',
  inspector: 'border-[var(--app-inspector)] bg-[var(--app-inspector-surface)]',
  inspectorLabel: 'bg-[var(--app-inspector)] text-[var(--app-inspector-foreground)]',
  brand: 'bg-[var(--app-brand)]',
  overlay: 'bg-[var(--app-overlay)]',
} as const

export type ThemeToken = keyof typeof themeTokens

/** Compose semantic appearance roles without choosing a concrete colour. */
export function theme(...tokens: ThemeToken[]): string {
  return tokens.map((token) => themeTokens[token]).join(' ')
}

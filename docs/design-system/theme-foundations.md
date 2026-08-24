# OpenLink Theme Foundations

OpenLink uses one semantic color system for light and dark modes. Components must describe their role (`background`, `popover`, `muted`, `border`, `primary`) instead of selecting a literal light or dark color.

For application-specific chrome, import `theme()` from `@/lib/theme` and compose
semantic roles such as `theme('surface', 'border')`. The function only emits
classes backed by this token contract; it must never accept a literal color.

## Architecture

The chosen approach is a scoped semantic theme that is explicitly propagated to every portal surface.

- The app shell owns the active theme through `data-theme="light|dark"`.
- `OpenLinkThemeProvider` exposes the resolved theme to shared client components.
- Portaled content receives the same theme automatically through `data-openlink-theme="light|dark"`.
- Both scopes expose the same standard tokens and OpenLink aliases.
- Base UI and ai-elements components consume standard tokens such as `--popover`, `--foreground`, `--accent`, and `--ring`.
- Product layout consumes OpenLink aliases such as `--app-background`, `--app-surface`, and `--app-muted`.

This avoids two rejected approaches:

- Synchronizing the whole document theme from the workspace would leak an app-only preference into marketing and authentication pages.
- Styling every popup with literal light/dark class pairs would duplicate decisions and eventually drift.

## Semantic color roles

| Role | Standard token | OpenLink alias | Intended use |
| --- | --- | --- | --- |
| Canvas | `--background` | `--app-background` | Page and application canvas |
| Surface | `--card` | `--app-surface` | Sidebar controls, prompt and inline panels |
| Raised surface | `--popover` | `--app-elevated` | Menus, dialogs, selectors and drawers |
| Selected surface | `--accent` | `--app-active` | Current navigation, selected menu item |
| Subtle surface | `--muted` | `--app-subtle-surface` | Passive fills and disabled backgrounds |
| Primary text | `--foreground` | `--app-foreground` | Titles, values and active icons |
| Secondary text | `--muted-foreground` | `--app-muted` / `--app-subtle` | Labels, descriptions and placeholders |
| Divider | `--border` | `--app-border` | Structural separators |
| Control border | `--input` | `--app-control-border` | Inputs and interactive surface borders |
| Focus | `--ring` | `--app-focus-ring` | Keyboard focus rings only |
| Primary action | `--primary` | `--app-submit-background` | Submit and confirmation actions |
| On primary | `--primary-foreground` | `--app-submit-foreground` | Text/icon on a primary action |
| Danger | `--destructive` | `--app-danger` / `--app-danger-surface` | Errors and destructive actions |
| Success | — | `--app-success` / `--app-success-surface` | Completed and healthy states |
| Warning | — | `--app-warning` / `--app-warning-surface` | Pending and degraded states |
| Information | — | `--app-info` / `--app-info-surface` | Informational and technical status |

## Component rules

1. Do not use `bg-white`, `bg-black`, `text-white`, `text-black`, or new hex colors for theme-dependent component chrome.
2. Brand assets and status colors may use fixed colors when the color itself carries identity or meaning. Interactive brand, danger, inspector, and overlay colors use the named `--app-*` token instead of an inline literal.
3. Menus, dialogs, command palettes, tooltips, popovers, hover cards, and selectors rendered through a shared primitive must inherit `data-openlink-theme` from `OpenLinkThemeProvider`. A product component must not implement its own portal theme logic.
4. Shared primitives use `bg-popover text-popover-foreground border-border`; product components compose the equivalent `theme('elevated', 'softBorder')` roles.
5. Hover and selected states use `bg-accent text-accent-foreground`; muted content uses `text-muted-foreground`.
6. Primary buttons use `bg-primary text-primary-foreground`; secondary actions use `bg-secondary text-secondary-foreground` or `variant="ghost"`.
7. Inputs use `border-input bg-background text-foreground placeholder:text-muted-foreground` and `focus-visible:ring-ring`.
8. SVG icons should use `currentColor`. Until exported assets are normalized, icon filters must be centralized in theme CSS classes rather than repeated per component.
9. Overlay stacking follows: navigation `z-40`, menus/dialog backdrops `z-50`, popup content `z-50` within its isolated layer. Raised surfaces must always be opaque.
10. Every shared component change is reviewed in both light and dark modes, including hover, focus, disabled, selected, error, and open states.
11. Theme switching is visual only. Theme selectors may change color, shadow, icon treatment, and other visual tokens, but must never change width, height, spacing, typography metrics, responsive breakpoints, or component placement.
12. `--app-subtle` and `--app-subtle-foreground` are text colors. Backgrounds must use `--app-subtle-surface`; mixing those roles is a contrast regression.

## Geometry and interaction

- Small controls: 28–32px height, 6–8px radius.
- Standard controls: 36–40px height, 8–10px radius.
- Raised surfaces: 12–16px radius, 1px semantic border, theme shadow token.
- Keyboard focus: visible 3px semantic ring; focus must not depend on color alone.
- Theme transitions apply to color, background, border, fill, and box-shadow and respect `prefers-reduced-motion`.
- The application sidebar uses one theme-independent geometry: 250px default/minimum and 280px maximum. Users may resize it on desktop; the chosen width persists across routes and theme changes. Theme scopes must not define `--app-sidebar-width`.

## Review checklist

- The component is legible at normal and muted contrast in both themes.
- No portal depends on CSS variables that exist only inside its trigger subtree.
- Shared portal primitives inherit the provider theme without product-level prop drilling.
- No theme-dependent literal color was introduced.
- Hover, selected, focus, disabled, destructive, and loading states remain visible.
- Icons have sufficient contrast without component-specific filter hacks.
- The page remains usable before client theme hydration and when following the system theme.

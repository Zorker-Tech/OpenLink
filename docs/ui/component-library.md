# OpenLink component library

OpenLink uses Storybook as the isolated workshop and living reference for UI components. The library mirrors the application's real global styles and semantic tokens, and includes light and dark themes, responsive viewports, generated documentation, accessibility inspection, and browser-based component tests.

## Run locally

```bash
pnpm storybook
```

Storybook runs at `http://localhost:6006`. A production-static build can be verified with:

```bash
pnpm storybook:build
```

Run every story as a browser component test with:

```bash
pnpm exec playwright install chromium
pnpm storybook:test
```

## Authoring contract

- Put reusable primitives in `components/ui`, reusable agent patterns in `components/ai-elements`, and product compositions in the top-level `components` folders.
- Add a colocated `*.stories.tsx` file for a new reusable component when it has a standalone visual or interactive contract.
- Model meaningful states: default, hover/focus where practical, disabled, loading, empty, error, destructive, long content, and narrow viewport.
- Use semantic variables from `app/globals.css`; do not hard-code a second visual language inside stories.
- Never represent a backend-bound state as working with fake runtime data. Isolate the visual subcomponent or document the integration requirement.
- Check both toolbar themes and the Accessibility panel before merging UI changes.

The Start Here inventory is generated from reusable `components/**/*.tsx` modules by `scripts/generate-storybook-inventory.mjs`. Demo bootstraps and their private children are deliberately excluded, while application-level components remain visible even when they cannot safely execute outside their real runtime.

/** Slate-owned values to apply to a box process environment. */
export interface BoxEnvironmentUpdate {
  env: Readonly<Record<string, string>>
  replace: boolean
}

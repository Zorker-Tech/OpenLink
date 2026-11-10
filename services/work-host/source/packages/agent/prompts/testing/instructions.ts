/**
 * The testing instructions as the prompt uses them.
 *
 * The instructions are written once and used from two places — the prompt that includes them and the
 * variants that place them differently — so the component is wrapped here rather than duplicated: what
 * a caller passes is what the component takes, and the wrapper only fixes the element type.
 */

import { jsx, type PromptNode, type PromptProps } from "../../../prompt-jsx/index.ts"
import { TestingInstructions } from "./testing-instructions.ts"

type TestingInstructionsOptions = Parameters<typeof TestingInstructions>[0]

export function TestingInstructions2(options: TestingInstructionsOptions) {
  return jsx(TestingInstructions as unknown as (props: PromptProps) => PromptNode, { ...options })
}

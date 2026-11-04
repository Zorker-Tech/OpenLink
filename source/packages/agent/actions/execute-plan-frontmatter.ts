import grayMatter from "gray-matter"
import type { PlanTodo } from "./execute-plan-contracts.ts"

/** Read the actionable rows from a plan without leaking protocol types into plan policy. */
export function collectPlanTodoDrafts(content: string): PlanTodo[] {
  try {
    const frontmatter = grayMatter(content).data
    const candidates = Array.isArray(frontmatter.phases)
      ? frontmatter.phases.flatMap((phase: { todos?: unknown[] }) => phase.todos ?? [])
      : Array.isArray(frontmatter.todos)
        ? frontmatter.todos
        : []

    return candidates
      .filter((todo: any) => todo?.id && todo?.content)
      .map((todo: any) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
        dependencies: todo.dependencies ?? [],
      }))
  } catch {
    return []
  }
}

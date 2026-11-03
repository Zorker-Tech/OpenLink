import type {
  CreateProjectActionInput,
  CreateProjectActionResult,
} from '@/lib/desktop-api/action-types'

import { callDesktopAction } from '../api'

export type { CreateProjectActionInput, CreateProjectActionResult }

export async function createProjectAction(
  input: CreateProjectActionInput,
): Promise<CreateProjectActionResult> {
  return callDesktopAction<CreateProjectActionResult>('projects.create', input)
}

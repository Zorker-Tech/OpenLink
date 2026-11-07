import { redirect } from 'next/navigation'

/**
 * Route old project-preview links through the project card action so Preview
 * opens in the chat workspace instead of a standalone page.
 */
export default async function WorkspacePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace_name: string }>
  searchParams: Promise<{ project?: string | string[] }>
}) {
  const [{ workspace_name: workspaceName }, { project: projectParam }] = await Promise.all([params, searchParams])
  const project = typeof projectParam === 'string' ? projectParam : undefined
  const query = new URLSearchParams({ openPreview: project || 'first-ready' })
  redirect(`/app/${workspaceName}/projects?${query.toString()}`)
}

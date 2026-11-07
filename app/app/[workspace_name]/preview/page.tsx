import { redirect } from 'next/navigation'

/**
 * Keep old project-preview URLs useful while routing Preview into its chat
 * workspace tab, where it shares the active project and code task.
 */
export default async function WorkspacePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace_name: string }>
  searchParams: Promise<{ project?: string }>
}) {
  const [{ workspace_name: workspaceName }, { project }] = await Promise.all([params, searchParams])
  const query = project ? `?project=${encodeURIComponent(project)}` : ''
  redirect(`/app/${workspaceName}${query}`)
}

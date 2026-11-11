import { createBot, listBots, BotInputError, resolveBotWorkspace } from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function errorResponse(code: string, status: number, message?: string) {
  return Response.json({ error: { code, message: message || code } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const workspaceSlug = new URL(request.url).searchParams.get('workspace')?.trim() || ''
  if (!workspaceSlug) return errorResponse('WORKSPACE_REQUIRED', 400)
  const workspace = await resolveBotWorkspace(supabase, workspaceSlug)
  if (!workspace) return errorResponse('WORKSPACE_NOT_FOUND', 404)
  try {
    return Response.json({ bots: await listBots(supabase, user.id, workspace.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[openlink-bots] list failed', error)
    return errorResponse('BOT_LIST_FAILED', 500)
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }
  const workspaceSlug = typeof body.workspaceSlug === 'string' ? body.workspaceSlug.trim() : ''
  if (!workspaceSlug) return errorResponse('WORKSPACE_REQUIRED', 400)
  try {
    const bot = await createBot(supabase, user.id, {
      workspaceSlug,
      name: body.name,
      description: body.description,
      avatarShape: body.avatarShape,
      avatarColor: body.avatarColor,
      avatarPngBase64: body.avatarPngBase64,
      model: body.model,
    })
    return Response.json({ bot }, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof BotInputError) return errorResponse(error.message, 400)
    console.error('[openlink-bots] create failed', error)
    return errorResponse('BOT_CREATE_FAILED', 502)
  }
}

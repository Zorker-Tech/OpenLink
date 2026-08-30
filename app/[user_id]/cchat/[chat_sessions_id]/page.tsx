import { redirect } from 'next/navigation'

/** Compatibility redirect for links created before the chat route typo was fixed. */
export default async function LegacyChatSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ user_id: string; chat_sessions_id: string }>
  searchParams: Promise<{ run?: string }>
}) {
  const [{ user_id: userId, chat_sessions_id: sessionId }, query] = await Promise.all([params, searchParams])
  const suffix = query.run ? `?run=${encodeURIComponent(query.run)}` : ''
  redirect(`/${userId}/chat/${sessionId}${suffix}`)
}

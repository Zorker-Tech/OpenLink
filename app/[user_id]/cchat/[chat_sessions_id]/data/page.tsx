import { redirect } from 'next/navigation'

/** Compatibility redirect for the legacy chat data route. */
export default async function LegacyChatDataPage({
  params,
}: {
  params: Promise<{ user_id: string; chat_sessions_id: string }>
}) {
  const { user_id: userId, chat_sessions_id: sessionId } = await params
  redirect(`/${userId}/chat/${sessionId}/data`)
}

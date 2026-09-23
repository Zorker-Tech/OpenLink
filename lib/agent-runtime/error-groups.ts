import type { Translator } from '../i18n/messages'

export interface AgentErrorRecord {
  id: string
  message: string
}

export interface AgentErrorGroup extends AgentErrorRecord {
  title: string
  messages: string[]
}

/** Used when a caller (tests, stories) renders without a locale provider. */
const sourceTranslator: Translator = (source) => source

export function agentErrorTitle(message: string, t: Translator = sourceTranslator): string {
  if (/reconnecting/i.test(message)) return t('Reconnecting…')
  if (/401|unauthorized|invalid api key/i.test(message)) return t('Agent 鉴权失败')
  if (/cancel(?:led|ed)/i.test(message)) return t('Agent 请求已取消')
  if (/timeout|timed out|stopped emitting/i.test(message)) return t('Agent 响应超时')
  if (/worker.*ended|worker.*exit/i.test(message)) return t('Agent Worker 已退出')
  return t('Agent 运行错误')
}

export function groupAgentErrorRecords(records: AgentErrorRecord[], t: Translator = sourceTranslator): AgentErrorGroup[] {
  const groups: AgentErrorGroup[] = []
  const byTitle = new Map<string, AgentErrorGroup>()
  for (const record of records) {
    const title = agentErrorTitle(record.message, t)
    const current = byTitle.get(title)
    if (current) {
      current.messages.push(record.message)
      continue
    }
    const group = { ...record, title, messages: [record.message] }
    byTitle.set(title, group)
    groups.push(group)
  }
  return groups
}

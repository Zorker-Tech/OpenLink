/**
 * Bot runtime projections are deliberately split across three durable records:
 * the Bot identity (`openlink.bots`), its hidden execution session
 * (`openlink.chat_sessions.surface = 'bot'`) and the Project that owns the
 * Ubuntu VM. A restore can leave any of those projections missing while the
 * Bot row remains valid.
 *
 * Keep the recovery decision pure so it can be exhaustively tested without a
 * database, and so a Code session can never be mistaken for a Bot session just
 * because it happens to have the same id shape.
 */

export type BotProjectionAction =
  | 'reuse'
  | 'repair-session'
  | 'recreate-project'
  | 'recreate-session'
  | 'rebuild-both'

export interface BotProjectionBot {
  userId: string
  workspaceId: string
  runtimeSessionId: string | null
  projectId: string | null
}

export interface BotProjectionSession {
  id: string
  userId: string
  workspaceId: string
  projectId: string
  surface: string
}

export interface BotProjectionProject {
  id: string
  workspaceId: string
}

export interface BotProjectionObservation {
  session: BotProjectionSession | null
  project: BotProjectionProject | null
}

export interface BotProjectionDecision {
  action: BotProjectionAction
  /** True when a new hidden Bot session must be created. */
  recreateSession: boolean
  /** True when an existing hidden Bot session must be repointed at the Project. */
  repairSession: boolean
  /** True when the Project projection must be recreated. */
  recreateProject: boolean
}

export function isBotProjectionSession(
  bot: BotProjectionBot,
  session: BotProjectionSession | null,
): session is BotProjectionSession {
  return Boolean(
    bot.runtimeSessionId
      && session
      && session.id === bot.runtimeSessionId
      && session.surface === 'bot'
      && session.userId === bot.userId
      && session.workspaceId === bot.workspaceId,
  )
}

export function isBotProjectionProject(
  bot: BotProjectionBot,
  project: BotProjectionProject | null,
): project is BotProjectionProject {
  return Boolean(
    bot.projectId
      && project
      && project.id === bot.projectId
      && project.workspaceId === bot.workspaceId,
  )
}

/**
 * Decide which projection must be rebuilt. The Bot row is the source of
 * identity; a mismatched session or project is never reused, even when its id
 * is still referenced by the Bot row.
 */
export function decideBotProjectionRecovery(
  bot: BotProjectionBot,
  observation: BotProjectionObservation,
): BotProjectionDecision {
  const { session, project } = observation
  const sessionValid = isBotProjectionSession(bot, session)
  const projectValid = isBotProjectionProject(bot, project)

  if (!sessionValid && !projectValid) {
    return {
      action: 'rebuild-both',
      recreateSession: true,
      repairSession: false,
      recreateProject: true,
    }
  }

  if (!sessionValid) {
    return {
      action: 'recreate-session',
      recreateSession: true,
      repairSession: false,
      recreateProject: false,
    }
  }

  if (!projectValid) {
    // The hidden session is still ours and is the durable execution identity.
    // Recreate only the Project projection and repoint the session; replacing
    // the session would discard its event log and Pi/OpenSandbox identity.
    return {
      action: 'recreate-project',
      recreateSession: false,
      repairSession: true,
      recreateProject: true,
    }
  }

  if (session.projectId !== project.id) {
    // Both records are owned by this Bot, but the session points at another
    // Project. Repair the mapping in place instead of creating a new Project.
    return {
      action: 'repair-session',
      recreateSession: false,
      repairSession: true,
      recreateProject: false,
    }
  }

  return {
    action: 'reuse',
    recreateSession: false,
    repairSession: false,
    recreateProject: false,
  }
}

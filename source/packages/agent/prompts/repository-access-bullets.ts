/**
 * What an agent with no repository is told.
 *
 * A session can be started without a checkout — the surface it came from has none — and the agent has
 * to be told twice over: that the absence is deliberate rather than broken, and what to do instead of
 * trying to work around it. Left unsaid, the missing checkout reads as an environment failure and the
 * agent spends the turn trying to restore access that was never going to be there.
 */

export function noRepositoryAccessBullets(): [string, string] {
  return [
    `This agent was launched WITHOUT a repository: no source code is checked out in your workspace and you have no access to the team's repositories or SCM credentials. Do not attempt to clone the team's repositories, push branches, or create pull requests — these will fail. Do not treat the missing checkout as an environment error or spend time trying to restore repository access.`,
    `If the task requires reading or modifying code in a repository, explain that this conversation runs without repository access and suggest starting the agent from a surface where a repository is checked out instead.`,
  ]
}

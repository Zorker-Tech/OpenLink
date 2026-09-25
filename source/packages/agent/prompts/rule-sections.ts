/**
 * The rules section of the first user message, and the three subsections inside it.
 *
 * The rules come from three places, and the model has to be told which is which because they are read
 * differently. The always-applied ones are in the prompt and are simply in force. The requestable ones
 * are described but not included: the model is told what each is about and where to read it, and reads
 * it only when the work calls for it — which is why the description names the tool to read with. The
 * user's own rules are included whole, because the user asked for them to be.
 *
 * A rule's own path decides which project it belongs to, and the description says so: a rule inside a
 * `.cursor/rules` directory belongs to the project that directory is in, and the path the model is given
 * is the part above that directory.
 */

import path from "node:path"

import type { CursorRule } from "../../proto/generated/agent/v1/rules_pb.ts"
import { jsx, jsxs } from "../../prompt-jsx/index.ts"
import type { PromptNode } from "../../prompt-jsx/index.ts"
import { normalizeToUnixPath } from "../../utils/paths.ts"
import { getFirstNonEmptyLine } from "../utils/common-helpers.ts"

const SEP = "/"

/** The project a rule belongs to: everything above its rules directory, or its own directory. */
export function getRuleDir(mdcPath: string): string {
  const normalizedPath = normalizeToUnixPath(mdcPath)
  const literalRuleDir = normalizeToUnixPath(path.normalize(path.dirname(normalizedPath)))
  const segments = literalRuleDir.split(SEP)
  for (let index = segments.length - 2; index >= 0; index--) {
    if (segments[index] === ".cursor" && segments[index + 1] === "rules") {
      const parentSegments = segments.slice(0, index)
      if (parentSegments.length === 0) return SEP
      return parentSegments.join(SEP)
    }
  }
  return literalRuleDir
}

/** What the model is told about a rule it has to fetch: its gist, and when it applies. */
export function getAgentRequestableRuleDescription(rule: CursorRule, ruleDir: string): string | undefined {
  if (rule.type?.type.case === "fileGlobbed") {
    const globPattern = rule.type.type.value.globs.join(", ")
    return `${getFirstNonEmptyLine(rule.content ?? "")}, glob pattern(s) for applicable files: ${globPattern}`
  }
  if (rule.type?.type.case === "agentFetched") {
    return rule.type.type.value.description
  }
  if (rule.type?.type.case === "global") {
    return `${getFirstNonEmptyLine(rule.content ?? "")}, applicable for all files within ${ruleDir}`
  }
  return undefined
}

function AlwaysAppliedWorkspaceRulesSection({ globalRules }: { readonly globalRules: readonly CursorRule[] }): PromptNode {
  return jsx("section", {
    title: "always_applied_workspace_rules",
    description: "These are workspace-level rules that the agent must always follow.",
    children: globalRules.map(rule => {
      const ruleGlobs = rule.type?.type.case === "fileGlobbed" ? rule.type.type.value.globs : undefined
      const ruleGlobsDescription = ruleGlobs ? `, glob pattern(s) for applicable files: ${ruleGlobs.join(", ")}` : ""
      return jsxs("x", {
        tag: "always_applied_workspace_rule",
        name: rule.fullPath,
        children: [rule.content, ruleGlobsDescription],
      })
    }),
  })
}

function AgentRequestableWorkspaceRulesSection({ agentRequestableRules, readToolName }: {
  readonly agentRequestableRules: readonly CursorRule[]
  readonly readToolName?: string | undefined
}): PromptNode {
  const description = readToolName
    ? `These are workspace-level rules that the agent should follow. Use the ${readToolName} tool to fetch full contents from the provided absolute path. Read each rule file using the ${readToolName} tool when it is relevant to your work.`
    : "These are workspace-level rules that the agent should follow. Fetch full contents from the provided absolute path."
  return jsx("section", {
    title: "agent_requestable_workspace_rules",
    description,
    children: agentRequestableRules.map(rule => jsx("x", {
      tag: "agent_requestable_workspace_rule",
      fullPath: rule.fullPath,
      children: getAgentRequestableRuleDescription(rule, getRuleDir(rule.fullPath)),
    })),
  })
}

/** The user's rules: the files they wrote, and the ones the platform generates for the session. */
function UserRulesSection({ userRules, composer2CustomUserRules = [] }: {
  readonly userRules: readonly CursorRule[]
  readonly composer2CustomUserRules?: readonly string[]
}): PromptNode {
  return jsxs("section", {
    title: "user_rules",
    description: "These are rules set by the user that you should follow if appropriate.",
    children: [
      composer2CustomUserRules.map(rule => jsx("x", { tag: "user_rule", children: rule })),
      userRules.map(rule => jsx("x", { tag: "user_rule", children: rule.content })),
    ],
  })
}

export function RulesSection({ globalRules, agentRequestableRules, userRules, readToolName, composer2CustomUserRules = [] }: {
  readonly globalRules: readonly CursorRule[]
  readonly agentRequestableRules: readonly CursorRule[]
  readonly userRules: readonly CursorRule[]
  readonly readToolName?: string | undefined
  readonly composer2CustomUserRules?: readonly string[]
}): PromptNode {
  const hasUserRules = userRules.length > 0 || composer2CustomUserRules.length > 0
  return jsxs("section", {
    title: "rules",
    children: [
      jsx("p", { children: "The rules section has a number of possible rules/memories/context that you should consider. In each subsection, we provide instructions about what information the subsection contains and how you should consider/follow the contents of the subsection." }),
      jsx("br", {}),
      globalRules.length > 0 && jsx(AlwaysAppliedWorkspaceRulesSection as unknown as (props: Record<string, unknown>) => PromptNode, { globalRules }),
      agentRequestableRules.length > 0 && jsx(AgentRequestableWorkspaceRulesSection as unknown as (props: Record<string, unknown>) => PromptNode, { agentRequestableRules, readToolName }),
      hasUserRules && jsx(UserRulesSection as unknown as (props: Record<string, unknown>) => PromptNode, { userRules, composer2CustomUserRules }),
      jsx("br", {}),
    ],
  })
}

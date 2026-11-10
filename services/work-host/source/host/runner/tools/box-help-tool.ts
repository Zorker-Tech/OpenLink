import { z } from "zod"
import { defineCommunicateTool } from "./communicate-tool.ts"
import { invariant } from "../../../shared/invariant.ts"
import { existingHandoffInstruction, handoffStartedReply, manualHandoffDescription } from "./box-help-messages.ts"
import { normalizeDestinationHost } from "./box-help-domain.ts"
import { connectorMessageFromEmission } from "./box-help-message-projection.ts"
import type { ManualHandoffPorts } from "./box-help-tool-contracts.ts"

export type { HandoffReason, HandoffRequestResult, ManualHandoffPorts } from "./box-help-tool-contracts.ts"
export { normalizeDestinationHost, connectorMessageFromEmission }

export const manualHandoffArguments = z.object({
  instruction: z.string().trim().min(1).describe(
    "One short instruction addressed to the user that names the manual step they should complete.",
  ),
  reason: z.enum(["auth", "captcha", "payment", "other"])
    .optional()
    .catch(undefined)
    .describe("The reason a person must act: sign-in, a bot check, payment confirmation, or another step."),
  domain: z.string().trim().optional().catch(undefined).describe(
    "Hostname of the destination app. Keep the app here after a sign-in redirect; leave it empty when unknown or unrelated to a website.",
  ),
  idp_domain: z.string().trim().optional().catch(undefined).describe(
    "Hostname of the identity provider shown after a sign-in redirect. Leave it empty for a direct app sign-in.",
  ),
})

export function createManualHandoffTool(ports: ManualHandoffPorts) {
  return defineCommunicateTool(ports, {
    id: "REQUEST_BOX_HELP",
    name: "request_box_help",
    description: manualHandoffDescription,
    parameters: manualHandoffArguments,
    async execute(
      _context,
      args: z.infer<typeof manualHandoffArguments>,
      resolved,
    ) {
      const agentId = resolved.getAgentId()
      invariant(agentId != null, "request_box_help was called outside an agent run.")
      resolved.endTurn()

      const domain = args.domain == null ? undefined : normalizeDestinationHost(args.domain)
      const idpDomain = args.idp_domain == null ? undefined : normalizeDestinationHost(args.idp_domain)
      const outcome = await resolved.requestHelp({
        agentId,
        instruction: args.instruction,
        telemetry: {
          ...(args.reason == null ? {} : { reason: args.reason }),
          ...(domain == null ? {} : { domain }),
          ...(idpDomain == null ? {} : { idpDomain }),
        },
      })

      if (outcome.kind === "already-pending") {
        return existingHandoffInstruction(outcome.instruction)
      }

      resolved.onSendMessage(
        { type: "text", content: args.instruction },
        (resolved.now ?? Date.now)(),
        { requestId: outcome.requestId, instruction: args.instruction },
      )
      return handoffStartedReply
    },
  })
}

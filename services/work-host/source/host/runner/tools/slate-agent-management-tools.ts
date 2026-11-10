/**
 * The tools an agent uses to manage other agents.
 *
 * They create one, send it something and update what it is for — each addressing an agent the way the platform does,
 * so an agent can only manage what it is allowed to.
 */
import { z } from "zod";
import {
  SLATE_CREATE_AGENT_TOOL_NAME,
  SLATE_SEND_TO_AGENT_TOOL_NAME,
  SLATE_UPDATE_AGENT_TOOL_NAME,
} from "../../agents/agent-messaging.ts";
import { defineCommunicateTool } from "./communicate-tool.ts";
import { isValidAttachmentUrl } from "./send-message-schema.ts";
import type { Context } from "../../../packages/context/context.ts";

export interface AgentImage {
  readonly url: string;
  readonly alt?: string;
}

export interface SendToAgentDependencies<_Context = Context> {
  getSelfAgentId(): string | undefined;
  resolveImageSource?(context: Context, sourceUrl: string): Promise<string>;
  sendToAgent(
    targetId: string,
    message: string,
    pictures?: readonly AgentImage[],
    priority?: true,
  ): string | Promise<string>;
}

export interface AgentManagementDependencies {
  create(profile: { readonly name: string; readonly description: string }): Promise<{
    readonly id: string;
    readonly name: string;
  }>;
  update(
    agentId: string,
    changes: { readonly name?: string; readonly description?: string },
  ): Promise<{ readonly id: string; readonly name: string } | null>;
}

const agentImageSchema = z.object({
  url: z.string().trim().min(1).describe("file:// or https:// URL of the image."),
  alt: z.string().trim().optional().describe(
    "Optional short description of this image, shown on hover and as its fullscreen caption.",
  ),
});

export const sendToAgentParameters = z.object({
  target_id: z.string().trim().min(1).describe(
    "The id of the target — either another agent or a GROUP you belong to. Use an id from your teammates list, ListAgents, or ListGroups — not a name.",
  ),
  message: z.string().trim().min(1).describe(
    "What to say. Write it as if texting a teammate: lead with the point, keep it short.",
  ),
  images: z.array(agentImageSchema).optional().describe(
    "Optional image(s) to send with the message — a screenshot, chart, or photo the other agent needs. Delivered with your message: a 1:1 recipient actually sees them (like an image the user sends), and they render with your text in the exchange. Not delivered to groups.",
  ),
  priority: z.boolean().optional().describe(
    "When true (1:1 only; ignored for groups), interrupt the recipient's current non-user work and wake them immediately — same steer as a direct user message. Use for STOP / supersede / time-critical instructions. Default false: waits out the current turn, but still runs ahead of automations and other background work.",
  ),
}).superRefine((input, refinement) => {
  for (const [position, entry] of (input.images ?? []).entries()) {
    if (!isValidAttachmentUrl(entry.url)) {
      refinement.addIssue({
        code: "custom",
        path: ["images", position, "url"],
        message: "each images url must include a file:// or https:// scheme",
      });
    }
  }
});

export const createAgentParameters = z.object({
  name: z.string().trim().min(1).describe("A short, human-readable name for the new agent."),
  description: z.string().trim().default("").describe(
    "The new agent's persona / instructions: what it is for and how it should behave. This becomes its profile and shapes its replies. Optional but strongly recommended.",
  ),
});

export const updateAgentParameters = z.object({
  agent_id: z.string().trim().min(1).describe("The id of the agent to update."),
  name: z.string().trim().optional().describe("A new name for the agent. Omit to leave the name unchanged."),
  description: z.string().trim().optional().describe("A new persona/description for the agent. Omit to leave it unchanged."),
});

export async function resolveSendToAgentImages(
  context: Context,
  images: readonly z.infer<typeof agentImageSchema>[],
  resolveImageSource?: (context: Context, sourceUrl: string) => Promise<string>,
): Promise<AgentImage[]> {
  const available: AgentImage[] = [];
  for (const picture of images) {
    const sourceUrl = resolveImageSource == null
      ? picture.url
      : await resolveImageSource(context, picture.url);
    const altText = picture.alt != null && picture.alt.length > 0 ? picture.alt : undefined;
    available.push({ url: sourceUrl, ...(altText == null ? {} : { alt: altText }) });
  }
  return available;
}

const SEND_TO_AGENT_DESCRIPTION = `Send a message to ANOTHER of your user's agents, OR post into a GROUP chat you belong to, by its id (not the user \u2014 SendMessage is how you reach the user). This is FIRE-AND-FORGET and asynchronous, like texting: it delivers your message, wakes that agent (or the group's members), and returns immediately with a delivery acknowledgement. Peer messages run ahead of automations and other background work; pass priority=true on a 1:1 send to interrupt the recipient's current non-user turn (STOP / supersede), like a direct user message (ignored for groups). It does NOT return their reply, and you must not wait or poll for one in this turn \u2014 send it and move on. Any reply arrives later as its own message that wakes you on a fresh turn. Get agent ids from your teammates list or ListAgents, and group ids from ListGroups. To include image(s) \u2014 a screenshot, chart, or photo the other agent needs \u2014 pass images: [{"url":"file:///absolute/path/to/shot.png","alt":"..."}] (file:// or https://). A 1:1 recipient actually sees them, like an image the user sends; never paste an image as a markdown ![](...) in the message text. Group posts are text-only today, so send images to an agent directly. Use it deliberately and sparingly \u2014 waking another agent or a whole group is a real side effect, so treat it like messaging on the user's behalf. Message someone or post to a group only when it truly serves the user's goal, not because one was mentioned or complained about, and don't spam a group. Never relay the user's private or unfiltered words (especially a complaint or criticism) verbatim; if relaying is warranted, paraphrase the actionable point diplomatically, not their tone. If you're unsure the user wants this sent, handle it yourself or ask first. Keep the message purposeful, professional, and minimal. One clearly relevant recipient can be normal work; messaging SEVERAL agents about the same effort (or posting it to a group) is a fan-out that wakes every recipient, and their replies land back in the user's chats and rooms \u2014 so fan out only when the user explicitly asked you to contact those agents. Otherwise propose it first with a question widget and wait for a yes, and never fan out "meanwhile" while you're waiting on the user for data or a decision.`;

const SELF_MESSAGE_REFUSAL = "You can't message yourself with SendToAgent. Use SendMessage to talk to the user, or pick a different target id.";

export function createSendToAgentTool(
  capabilities: SendToAgentDependencies,
) {
  return defineCommunicateTool(capabilities, {
    id: "SEND_TO_TASK",
    name: SLATE_SEND_TO_AGENT_TOOL_NAME,
    description: SEND_TO_AGENT_DESCRIPTION,
    parameters: sendToAgentParameters,
    describeActivity: (parsedInput: z.infer<typeof sendToAgentParameters>) => ({
      target: parsedInput.target_id,
    }),
    async execute(context: Context, parsedInput: z.infer<typeof sendToAgentParameters>, available) {
      const selfId = available.getSelfAgentId();
      if (selfId != null && parsedInput.target_id === selfId) {
        return SELF_MESSAGE_REFUSAL;
      }
      const pictures = await resolveSendToAgentImages(
        context,
        parsedInput.images ?? [],
        available.resolveImageSource,
      );
      return available.sendToAgent(
        parsedInput.target_id,
        parsedInput.message,
        pictures.length > 0 ? pictures : undefined,
        parsedInput.priority === true ? true : undefined,
      );
    },
  });
}

const CREATE_AGENT_DESCRIPTION = `Create a new agent (a new teammate assistant) for your user, with a name and an optional persona/description. Returns the new agent's id so you can immediately message it with SendToAgent. Use this to spin up a focused teammate for a job. You have no tool to delete an agent, so only create one when it is genuinely useful; the user can delete an agent themselves from the sidebar (right-click the agent \u2192 "Delete").`;

export function createCreateAgentTool(agentManagement: AgentManagementDependencies) {
  return defineCommunicateTool(agentManagement, {
    id: "CREATE_TASK",
    name: SLATE_CREATE_AGENT_TOOL_NAME,
    description: CREATE_AGENT_DESCRIPTION,
    parameters: createAgentParameters,
    async execute(_context, parsedInput: z.infer<typeof createAgentParameters>, available) {
      const createdAgent = await available.create({
        name: parsedInput.name,
        description: parsedInput.description,
      });
      return `Created agent "${createdAgent.name}" (id: ${createdAgent.id}). Message it with SendToAgent using that id.`;
    },
  });
}

const UPDATE_AGENT_DESCRIPTION = "Edit an existing agent's profile: its name and/or description. Only the fields you provide are changed; the rest are left exactly as they were, and there is no way to clear or delete an agent through this tool. Use it to refine a teammate you (or the user) created.";

const NOTHING_TO_UPDATE_MESSAGE = "Nothing to update: provide a new name and/or description.";

function fieldsToUpdate(name: string | undefined, description: string | undefined): { name?: string; description?: string } {
  const changes: { name?: string; description?: string } = {};
  if (name != null && name.length > 0) changes.name = name;
  if (description != null && description.length > 0) changes.description = description;
  return changes;
}

export function createUpdateAgentTool(agentManagement: AgentManagementDependencies) {
  return defineCommunicateTool(agentManagement, {
    id: "PLATFORM_ACTION",
    name: SLATE_UPDATE_AGENT_TOOL_NAME,
    description: UPDATE_AGENT_DESCRIPTION,
    parameters: updateAgentParameters,
    describeActivity: (parsedInput: z.infer<typeof updateAgentParameters>) => ({
      target: parsedInput.agent_id,
    }),
    async execute(_context, parsedInput: z.infer<typeof updateAgentParameters>, available) {
      const changes = fieldsToUpdate(parsedInput.name, parsedInput.description);
      if (changes.name == null && changes.description == null) {
        return NOTHING_TO_UPDATE_MESSAGE;
      }
      const updatedAgent = await available.update(parsedInput.agent_id, changes);
      return updatedAgent == null
        ? `No agent found with id ${parsedInput.agent_id}.`
        : `Updated agent "${updatedAgent.name}" (id: ${updatedAgent.id}).`;
    },
  });
}

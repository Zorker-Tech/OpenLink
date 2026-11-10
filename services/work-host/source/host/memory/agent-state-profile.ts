/** Profile, preference and channel changes allowed through the self-state API. */
import { isBlankAgentText, stateWriteFailed, stateWriteOk, type AgentStateDeps } from "./agent-state-contracts.ts";

export function createAgentProfileOperations(deps: AgentStateDeps) {
  return {
    async updateProfile(args: { name?: string; description?: string }) {
      if (args.name === undefined && args.description === undefined) {
        return stateWriteFailed("nothing to change — pass at least one of name or description.");
      }
      if (args.name !== undefined && isBlankAgentText(args.name)) return stateWriteFailed("a blank name is not allowed.");

      const current = deps.readProfile() ?? {};
      const next = {
        ...current,
        ...(args.name === undefined ? {} : { name: args.name.trim() }),
        ...(args.description === undefined ? {} : { description: args.description.trim() }),
      };
      deps.writeProfile(next);
      const changed = [args.name === undefined ? "" : "name", args.description === undefined ? "" : "description"].filter(Boolean);
      return stateWriteOk(`Updated your ${changed.join(", ")}.`);
    },

    async updateSettings(args: { hiddenFromSidebar?: boolean; notifyOnAgentUpdates?: boolean }) {
      const settings = {
        ...(args.hiddenFromSidebar === undefined ? {} : { hiddenFromSidebar: args.hiddenFromSidebar }),
        ...(args.notifyOnAgentUpdates === undefined ? {} : { notifyOnAgentUpdates: args.notifyOnAgentUpdates }),
      };
      if (Object.keys(settings).length === 0) return stateWriteFailed("nothing to change — pass at least one setting field.");
      deps.writeSettings(settings);
      return stateWriteOk(`Updated your settings: ${Object.keys(settings).join(", ")}.`);
    },

    async disconnectChannel(args: { platform: string }) {
      return deps.channels.remove(args.platform)
        ? stateWriteOk(`Disconnected ${args.platform}. The connector closes the live connection within a few seconds.`)
        : stateWriteFailed(`${args.platform} is not connected.`);
    },
  };
}

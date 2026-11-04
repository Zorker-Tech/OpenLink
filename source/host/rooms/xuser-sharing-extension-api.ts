import { EMPTY_SLATE_SHARING_STATE } from "../../shared/agents/sharing.ts";
import { SHARING_DISABLED_MESSAGE, type SharingApiService } from "./xuser-sharing-extension-contracts.ts";

/** Keep the cross-user extension surface small and return stable disabled answers at each entry point. */
export function createCrossUserSharingApi(args: {
  readonly service: SharingApiService;
  readonly isEnabled: () => boolean;
  readonly listeners: Set<(state: unknown) => void>;
}) {
  return {
    get isEnabled() { return args.isEnabled(); },
    getSharingState: async () => args.service.getState(),
    createRoomFromAgent: async (input: { agentId: string }) => args.isEnabled()
      ? await args.service.createRoomFromAgent(input.agentId)
      : { status: "error", message: SHARING_DISABLED_MESSAGE },
    createRoomInvite: async (input: { roomId: string }) => args.isEnabled()
      ? await args.service.createRoomInvite(input.roomId)
      : { status: "error", message: SHARING_DISABLED_MESSAGE },
    joinSharedRoom: async (input: { link: string }) => args.isEnabled()
      ? await args.service.joinRoom(input.link)
      : { status: "error", message: SHARING_DISABLED_MESSAGE },
    respondToRoomJoinRequest: async (input: { requestId: string; [key: string]: unknown }) => args.isEnabled()
      ? await args.service.respondToJoinRequest(input)
      : EMPTY_SLATE_SHARING_STATE,
    createSharedRoom: async (input: { agents: Array<Record<string, unknown>>; [key: string]: unknown }) => args.isEnabled()
      ? await args.service.createSharedRoom(input)
      : { status: "error", message: SHARING_DISABLED_MESSAGE },
    addOwnAgentToSharedRoom: async (input: { agentId: string; [key: string]: unknown }) => args.isEnabled()
      ? await args.service.addOwnAgent(input)
      : EMPTY_SLATE_SHARING_STATE,
    removeOwnAgentFromSharedRoom: async (input: { roomId: string; agentId: string }) => args.isEnabled()
      ? await args.service.removeOwnAgent(input.roomId, input.agentId)
      : EMPTY_SLATE_SHARING_STATE,
    setSharedRoomTyping: async (input: { roomId: string; isTyping: boolean }) => {
      if (args.isEnabled()) await args.service.setRoomTyping(input.roomId, input.isTyping);
    },
    leaveSharedRoom: async (input: { roomId: string; targetAuthId?: string }) => args.isEnabled()
      ? await args.service.leaveSharedRoom(input.roomId, input.targetAuthId)
      : EMPTY_SLATE_SHARING_STATE,
    noteAgentDeleted: async (agentId: string) => {
      if (args.isEnabled()) await args.service.noteAgentDeleted(agentId);
    },
    subscribe(listener: (state: unknown) => void) {
      args.listeners.add(listener);
      return () => args.listeners.delete(listener);
    },
    prepareForUpgrade: () => args.service.stop(),
    resumeAfterRecreate: async () => {
      if (args.isEnabled()) await args.service.start();
    },
  };
}

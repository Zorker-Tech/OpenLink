export type AgentImageResourceResult =
  | {
      readonly result: {
        readonly case: "success";
        readonly value: { readonly path?: string; readonly fileSize?: number; readonly data?: Uint8Array };
      };
    }
  | {
      readonly result: {
        readonly case: "error";
        readonly value: { readonly path?: string; readonly error: string };
      };
    };

export interface AgentImageResourcePort {
  readonly write: (request: { readonly path: string; readonly fileBytes: Uint8Array }) => Promise<AgentImageResourceResult>;
  readonly read: (request: { readonly path: string }) => Promise<AgentImageResourceResult>;
}

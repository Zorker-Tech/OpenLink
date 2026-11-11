export type AgentId = 'chief-of-staff' | 'sales-outbound' | 'inbox-manager' | 'account-manager' | 'talent-scout' | 'expense-manager' | 'offsite-crew';
export type Agent = {
    id: AgentId;
    name: string;
    preview: string;
    timeLabel: string;
    ink: string;
    avatar: string;
    unread?: boolean;
    group?: AgentId[];
};
export type PendingBeat = {
    label: string | null;
    showLabel: boolean;
};
export type ComputerStatus = 'action-needed' | 'handed-over' | 'working' | 'done';
export type ComputerEntry = {
    kind: 'computer';
    id: string;
    instruction: string;
    ask: string;
    status: ComputerStatus;
    screenKind: 'crm-portal';
    timestampMs?: number;
};
export type AgentMessageEntry = {
    kind: 'agent-message';
    id: string;
    content: string;
    timestampMs: number;
    author?: {
        id: string;
        name: string;
    };
    reactions?: string[];
};
export type UserMessageEntry = {
    kind: 'user-message';
    id: string;
    content: string;
    timestampMs: number;
    reactions?: string[];
};
export type SystemEntryData = {
    kind: 'system';
    id: string;
    event: {
        type: 'renamed';
        name: string;
    } | {
        type: 'received-context';
        sources: {
            name: string;
        }[];
    } | {
        type: 'created-routine';
        name: string;
        triggerDescription: string;
    } | {
        type: 'memory-updated';
    };
    timestampMs: number;
};
export type TranscriptEntry = AgentMessageEntry | UserMessageEntry | ComputerEntry | SystemEntryData;
export type ScreenView = 'login' | 'portal';
export type ScriptedScreen = {
    view: ScreenView;
    emailChars: number;
    passwordChars: number;
    focus: 'email' | 'password' | null;
    isWorking: boolean;
};
export type ScreenOverlayState = {
    mode: 'takeover' | 'lightbox';
    origin: 'entry' | 'pane';
    instruction?: string;
};
export type CursorState = {
    x: number;
    y: number;
    duration: number;
    visible: boolean;
};
//# sourceMappingURL=types.d.ts.map
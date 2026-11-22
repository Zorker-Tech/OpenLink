import type { AppSession } from '../app/data';
import type { ActivityEntry, AgentMessageEntry, ConfirmationEntry, SystemEntryData, UserMessageEntry } from '../types';
export type OpenLinkDemoScenario = 'computer' | 'team' | 'routine';
export declare function message(kind: 'agent-message', id: string, content: string, author?: string): AgentMessageEntry;
export declare function message(kind: 'user-message', id: string, content: string): UserMessageEntry;
export declare function activity(id: string, label: string, detail: string): ActivityEntry;
export declare function confirmation(id: string, title: string, description: string): ConfirmationEntry;
export declare function scheduled(triggerDescription: string): SystemEntryData;
type Scenario = {
    label: string;
    description: string;
    prompt: string;
    session: AppSession;
    followUp: string;
};
export declare const scenarios: Record<OpenLinkDemoScenario, Scenario>;
export declare const scenarioIds: OpenLinkDemoScenario[];
export declare const tickets: {
    id: string;
    title: string;
    priority: string;
    detail: string;
}[];
export declare const teamMembers: {
    id: string;
    name: string;
}[];
export {};
//# sourceMappingURL=scenarios.d.ts.map
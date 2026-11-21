import { type ReactNode } from 'react';
export type AppComposerProps = {
    displayName: string;
    disabled: boolean;
    showRoutine?: boolean;
    status?: ReactNode;
    reply?: {
        excerpt: string;
        onJump: () => void;
        onCancel: () => void;
    };
    replyPlaceholder?: string;
    groupMembers?: readonly {
        id: string;
        name: string;
    }[];
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onCreateRoutine?: () => void;
};
export declare function AppComposer({ displayName, disabled, showRoutine, status, reply, replyPlaceholder, groupMembers, value, onChange, onSend, onCreateRoutine, }: AppComposerProps): import("react").JSX.Element;
//# sourceMappingURL=AppComposer.d.ts.map
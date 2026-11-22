import { type AppSession } from './data';
export type PaletteSession = {
    session: AppSession;
    name: string;
};
export type AppCommandPaletteProps = {
    sessions: PaletteSession[];
    query: string;
    assetBase: string;
    onQueryChange: (value: string) => void;
    onClose: () => void;
    onSelect: (sessionId: string) => void;
    onCreate?: (query: string) => void;
    scopeKeyboard?: boolean;
};
export declare function AppCommandPalette({ sessions, query, assetBase, onQueryChange, onClose, onSelect, onCreate, scopeKeyboard, }: AppCommandPaletteProps): import("react").JSX.Element;
//# sourceMappingURL=AppCommandPalette.d.ts.map
import { type AppSession } from './data';
export type AppSidebarRow = {
    session: AppSession;
    name: string;
    preview: string;
    time: string;
    unread?: boolean;
};
export type AppSidebarProps = {
    rows: AppSidebarRow[];
    activeId: string;
    collapsed: boolean;
    search: string;
    assetBase: string;
    onSearch: (value: string) => void;
    onSearchFocus: () => void;
    onSelect: (sessionId: string) => void;
    onNewAgent: () => void;
};
export declare function AppSidebar({ rows, activeId, collapsed, search, assetBase, onSearch, onSearchFocus, onSelect, onNewAgent, }: AppSidebarProps): import("react").JSX.Element;
//# sourceMappingURL=AppSidebar.d.ts.map
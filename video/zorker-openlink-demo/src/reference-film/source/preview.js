import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useEffect, useRef, useState } from 'react';
import { staticFile } from 'remotion';
import { ArrowLeft, ArrowRight, ChevronDown, Code2, Database, ExternalLink, Globe2, Inspect, MessageCircle, MoreHorizontal, PanelLeft, RotateCw, Send, Share2, X } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../source-snapshot/components/ui/dropdown-menu.js';
/**
 * Shared semantic class package for OpenLink surfaces.
 *
 * Theme decisions belong to CSS variables in `app/globals.css`; components
 * select a role here rather than embedding a light or dark colour value.
 * Keeping the complete class strings in this module also makes them visible
 * to Tailwind's static scanner.
 */
export const themeTokens = {
    canvas: 'bg-[var(--app-background)] text-[var(--app-foreground)]',
    surface: 'bg-[var(--app-surface)] text-[var(--app-foreground)]',
    elevated: 'bg-[var(--app-elevated)] text-[var(--app-foreground)]',
    editor: 'bg-[var(--app-editor-background)] text-[var(--app-foreground)]',
    active: 'bg-[var(--app-active)] text-[var(--app-foreground)]',
    selected: 'bg-[var(--app-selected)] text-[var(--app-foreground)]',
    subtleSurface: 'bg-[var(--app-subtle-surface)] text-[var(--app-foreground)]',
    muted: 'text-[var(--app-muted)]',
    subtle: 'text-[var(--app-subtle-foreground)]',
    border: 'border-[var(--app-control-border)]',
    softBorder: 'border-[var(--app-border)]',
    divider: 'bg-[var(--app-border)]',
    hover: 'hover:bg-[var(--app-hover)]',
    action: 'bg-[var(--app-submit-background)] text-[var(--app-submit-foreground)]',
    actionHover: 'hover:bg-[var(--app-submit-hover)]',
    critical: 'text-[var(--app-danger)]',
    criticalSurface: 'bg-[var(--app-danger-surface)]',
    positive: 'text-[var(--app-success)]',
    positiveSurface: 'bg-[var(--app-success-surface)]',
    warning: 'text-[var(--app-warning)]',
    warningSurface: 'bg-[var(--app-warning-surface)]',
    info: 'text-[var(--app-info)]',
    infoSurface: 'bg-[var(--app-info-surface)]',
    inspector: 'border-[var(--app-inspector)] bg-[var(--app-inspector-surface)]',
    inspectorLabel: 'bg-[var(--app-inspector)] text-[var(--app-inspector-foreground)]',
    brand: 'bg-[var(--app-brand)]',
    overlay: 'bg-[var(--app-overlay)]',
};
/** Compose semantic appearance roles without choosing a concrete colour. */
export function theme(...tokens) {
    return tokens.map((token) => themeTokens[token]).join(' ');
}
export function ToolbarButton({ label, children, className = '', ...props }) {
    return (_jsx("button", { "aria-label": label, className: `flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)] disabled:pointer-events-none disabled:opacity-35 ${className}`, type: "button", ...props, children: children }));
}
const filmT = (key, values = {}) => {
    const copy = { 'Preview': 'Preview', 'Live浏览器': 'Live', 'Live': 'Live', 'Code': 'Code', 'Data库': 'Database', '工作区标签': 'Workspace tabs', '关闭{label}标签': 'Close {label} tab', 'Chat': 'Chat', 'More': 'More', 'Share': 'Share', 'Publish': 'Publish', '浏览器工具栏': 'Browser toolbar', 'Back': 'Back', 'Forward': 'Forward', 'Device': 'Device', '浏览器地址': 'Browser address', '输入网址或搜索': 'Enter a URL or search', 'Select component': 'Select component', 'Open externally': 'Open externally', 'Reload': 'Reload', 'MorePreview选项': 'More preview options', '切换Preview版本': 'Switch preview version', 'Current': 'Current', '正在读取 Git 版本…': 'Reading Git versions…', '暂无可切换的 Git 版本': 'No Git versions to switch', ' · Current commit': ' · current commit' };
    return (copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ('{' + name + '}')));
};
function workspaceTabs(t) {
    return [
        { id: 'preview', label: t('Preview'), icon: Globe2 },
        { id: 'realtime', label: t('Live浏览器'), icon: Send },
        { id: 'code', label: t('Code'), icon: Code2 },
        { id: 'database', label: t('Data库'), icon: Database },
    ];
}
function WorkspaceTabs({ activeTab, onClose, onSelect, openTabs, }) {
    const t = filmT;
    const tabs = workspaceTabs(t);
    return (_jsx("div", { "aria-label": t('工作区标签'), className: "flex h-7 min-w-0 flex-1 items-center overflow-hidden", children: _jsx("div", { className: "flex min-w-0 items-center overflow-x-auto pr-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", children: _jsx(React.Fragment, { children: openTabs.map((tabId) => {
                    const tab = tabs.find((candidate) => candidate.id === tabId);
                    const Icon = tab.icon;
                    const selected = tabId === activeTab;
                    return (_jsxs("div", { className: `group mr-0.5 flex h-7 min-w-[112px] max-w-[126px] shrink-0 items-center rounded-lg transition-[background-color,color,box-shadow] duration-150 ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)] shadow-[inset_0_0_0_1px_var(--app-control-border),0_1px_2px_var(--app-shadow)]' : 'bg-[var(--app-surface)] text-[var(--app-muted)] shadow-[inset_0_0_0_1px_var(--app-control-border)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]'}`, children: [_jsxs("button", { "aria-selected": selected, className: "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2 text-[13px] font-medium tracking-[-0.0762px]", role: "tab", type: "button", children: [_jsx(Icon, { "aria-hidden": true, className: "size-3.5 shrink-0" }), _jsx("span", { className: "truncate", children: tab.label })] }), _jsx("button", { "aria-label": t('关闭{label}标签', { label: tab.label }), className: `mr-1 flex size-5 shrink-0 items-center justify-center rounded text-[var(--app-subtle)] transition-[color,background-color,opacity] hover:bg-[var(--app-control-border)] hover:text-[var(--app-foreground)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)] ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`, type: "button", children: _jsx(X, { "aria-hidden": true, className: "size-3" }) })] }, tabId));
                }) }) }) }));
}
function BrowserNavigationBar({ browserState, browserWorkbenchRef, gitVersions, gitVersionsLoading, gitVersionError, onSelectGitVersion, onToggleDeviceView, selectedGitRef, workspaceView, }) {
    const [addressDraft, setAddressDraft] = useState(browserState.address);
    const addressInputRef = useRef(null);
    const t = filmT;
    useEffect(() => {
        if (document.activeElement !== addressInputRef.current)
            setAddressDraft(browserState.address);
    }, [browserState.address]);
    return (_jsxs("div", { "aria-label": t('浏览器工具栏'), className: "flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--app-border)] bg-[var(--app-background)] p-2 text-[var(--app-foreground)]", children: [_jsx("div", { "aria-hidden": true, className: "size-7 shrink-0" }), _jsx("div", { className: "flex min-w-[150px] flex-1 items-center justify-center", children: _jsxs("form", { className: "flex h-7 w-full max-w-[500px] items-center overflow-hidden rounded-md border border-[var(--app-control-border)] px-0.5", children: [_jsx(ToolbarButton, { className: "size-6! rounded", disabled: !browserState.canGoBack, label: t("Back"), children: _jsx(ArrowLeft, { className: "size-4" }) }), _jsx(ToolbarButton, { className: "size-6! rounded", disabled: !browserState.canGoForward, label: t("Forward"), children: _jsx(ArrowRight, { className: "size-4" }) }), _jsx(ToolbarButton, { "aria-pressed": workspaceView === 'mobile', className: "size-6! rounded hover:bg-transparent!", label: t("Device"), children: _jsx("img", { alt: "", className: "app-control-icon size-4", src: staticFile('openlink/app/phone.svg') }) }), _jsx("input", { "aria-label": t('浏览器地址'), className: "h-6 min-w-0 flex-1 bg-transparent px-1 text-[12px] tracking-[-0.0762px] text-[var(--app-muted)] outline-none focus:text-[var(--app-foreground)]", placeholder: t('输入网址或搜索'), spellCheck: false, value: addressDraft }), _jsx(ToolbarButton, { "aria-pressed": browserState.inspectMode, className: `size-6! rounded ${browserState.inspectMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''}`, disabled: !browserState.canInspect, label: t('Select component'), children: _jsx(Inspect, { className: "size-4" }) }), _jsx(ToolbarButton, { className: "size-6! rounded", disabled: !browserState.externalUrl, label: t("Open externally"), children: _jsx(ExternalLink, { className: "size-4" }) }), _jsx(ToolbarButton, { className: "size-6! rounded", disabled: !browserState.canInspect, label: t("Reload"), children: _jsx(RotateCw, { className: "size-4" }) }), _jsx(ToolbarButton, { className: "size-6! rounded", label: t("MorePreview选项"), children: _jsx(ChevronDown, { className: "size-4" }) })] }) }), _jsxs(DropdownMenu, { children: [_jsxs(DropdownMenuTrigger, { render: _jsx("button", { "aria-label": t('切换Preview版本'), className: "flex h-7 w-[96px] shrink-0 items-center justify-center gap-1 rounded-md text-sm font-medium tracking-[-0.1504px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]", type: "button" }), children: [_jsx("span", { className: "max-w-[70px] truncate", children: selectedGitRef ? `@${gitVersions.find((version) => version.ref === selectedGitRef)?.shortRef ?? selectedGitRef.slice(0, 8)}` : 'Latest' }), _jsx(ChevronDown, { className: "size-4" })] }), _jsxs(DropdownMenuContent, { align: "end", className: "w-[280px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0", children: [_jsxs(DropdownMenuItem, { className: "h-9 cursor-pointer gap-2 rounded-md px-2.5 text-sm focus:bg-[var(--app-hover)]", disabled: !selectedGitRef, children: [_jsx("span", { className: "min-w-0 flex-1 truncate", children: "Latest" }), !selectedGitRef && _jsx("span", { className: "text-[11px] text-[var(--app-muted)]", children: t('Current') })] }), gitVersionsLoading && _jsx("div", { className: "px-2.5 py-2 text-xs text-[var(--app-muted)]", children: t('正在读取 Git 版本…') }), !gitVersionsLoading && gitVersions.length === 0 && _jsx("div", { className: "px-2.5 py-2 text-xs text-[var(--app-muted)]", children: t('暂无可切换的 Git 版本') }), !gitVersionsLoading && gitVersions.map((version) => (_jsx(DropdownMenuItem, { className: "h-auto min-h-9 cursor-pointer gap-2 rounded-md px-2.5 py-1.5 text-sm focus:bg-[var(--app-hover)]", children: _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate", children: version.message }), _jsxs("span", { className: "block text-[11px] text-[var(--app-muted)]", children: ["@", version.shortRef, version.current ? t(' · Current commit') : ''] })] }) }, version.ref))), gitVersionError && _jsx("div", { className: "px-2.5 py-2 text-xs text-[var(--app-danger)]", children: gitVersionError })] })] })] }));
}
/** Current chat-side header JSX/layout from ChatTopbar; app actions are inert. */
export function SourceChatTopbar({ title = 'Forma · Landing page' } = {}) {
    const side = 'chat', collapsed = false, chatCollapsed = false, sessionTitle = title, editingTitle = false, titleDraft = title, savingTitle = false, titleWidth = 176;
    const t = (key) => ({ '打开侧边栏': 'Open sidebar', '展开侧边栏': 'Expand sidebar', 'Edit project name': 'Edit session name' }[key] ?? key);
    return _jsx("header", { className: "flex h-[50px] shrink-0 items-center overflow-hidden border-b border-[var(--app-border)] bg-[var(--app-background)] text-[var(--app-foreground)]", children: side === 'chat' && (_jsxs("div", { "aria-hidden": chatCollapsed, className: "flex size-full min-w-0 items-center px-3", "data-header-region": "chat-title", style: { pointerEvents: chatCollapsed ? 'none' : 'auto' }, children: [_jsx("button", { "aria-label": t('打开侧边栏'), className: "flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] md:hidden", type: "button", children: _jsx(PanelLeft, { className: "size-4" }) }), collapsed && _jsx("button", { "aria-label": t('展开侧边栏'), className: "hidden size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-active)] md:flex", type: "button", children: _jsx(PanelLeft, { className: "size-4" }) }), _jsxs("div", { className: "relative flex h-7 min-w-0 items-center", children: [_jsx("span", { "aria-hidden": "true", className: "pointer-events-none absolute -left-[9999px] top-0 max-w-[210px] truncate text-[13px] font-medium tracking-[-0.0762px] opacity-0", children: sessionTitle }), _jsx("div", { className: "flex h-7 min-w-0 items-center overflow-hidden", style: { width: titleWidth }, children: editingTitle ? (_jsx("input", { "aria-label": t('Edit project name'), className: "h-7 w-full min-w-0 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]", "data-no-press-motion": true, disabled: savingTitle, maxLength: 120, value: titleDraft }, "title-editor")) : (_jsx("button", { "aria-label": t('Edit project name'), className: "flex h-7 w-full min-w-0 items-center rounded-md px-1 text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]", "data-no-press-motion": true, type: "button", children: _jsx("span", { className: "max-w-[210px] truncate", children: sessionTitle }) }, "title-display")) })] })] })) });
}
export const exampleVersions = [{ ref: 'f173c02', shortRef: 'f173c02', message: 'Electric blue refinement', current: true }, { ref: 'b7401a8', shortRef: 'b7401a8', message: 'Warm neutral foundation', current: false }];
/** Current workspace-side ChatTopbar with one deterministic Preview tab. */
export function SourceTopbar() {
    const side = 'workspace', collapsed = false, chatCollapsed = false, localRuntime = false, dataSurface = 'panel', workspaceView = 'browser', activeTab = 'preview', openTabs = ['preview'];
    const onToggleSidebar = () => { }, onToggleChat = () => { }, onToggleDataSurface = () => { }, onCloseWorkspaceTab = () => { }, onSelectWorkspaceTab = () => { };
    const t = filmT;
    return _jsxs("header", { className: "flex h-[50px] shrink-0 items-center overflow-hidden border-b border-[var(--app-border)] bg-[var(--app-background)] text-[var(--app-foreground)]", children: [side === 'workspace' && (_jsx("div", { className: "flex min-w-0 flex-1 items-center", "data-header-region": "workspace-tabs", children: _jsxs("div", { className: "flex size-full min-w-0 items-center gap-1.5 pl-3 pr-1.5", children: [chatCollapsed && collapsed && _jsx(ToolbarButton, { label: t('展开侧边栏'), children: _jsx(PanelLeft, { className: "size-4" }) }), _jsx(ToolbarButton, { "aria-pressed": chatCollapsed, className: chatCollapsed ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : '', label: t('Chat'), children: _jsx(MessageCircle, { className: "size-4" }) }), _jsx(WorkspaceTabs, { activeTab: activeTab, openTabs: openTabs }), workspaceView === 'data' && localRuntime && _jsxs("button", { "aria-pressed": dataSurface === 'studio', className: `flex h-[26px] shrink-0 items-center gap-1 rounded-full border border-[var(--app-control-border)] px-2.5 text-xs font-medium transition-colors ${dataSurface === 'studio' ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'bg-[var(--app-surface)] text-[var(--app-muted)] hover:text-[var(--app-foreground)]'}`, type: "button", children: [_jsx(ExternalLink, { className: "size-3" }), "Studio"] })] }) })), side === 'workspace' && (_jsxs("div", { className: "flex w-[150px] shrink-0 items-center gap-1.5 pr-3", children: [_jsx(ToolbarButton, { className: "border border-[var(--app-control-border)] bg-[var(--app-surface)]", label: t("More"), children: _jsx(MoreHorizontal, { className: "size-4" }) }), _jsx(ToolbarButton, { className: "border border-[var(--app-control-border)] bg-[var(--app-surface)]", label: t("Share"), children: _jsx(Share2, { className: "size-4" }) }), _jsxs("button", { className: `relative flex h-7 w-[70px] items-center justify-center gap-1.5 rounded-md border border-[var(--app-submit-background)] text-sm font-medium tracking-[-0.1504px] after:absolute after:-right-1 after:-top-1 after:size-3 after:rounded-full after:border-[1.5px] after:border-[var(--app-background)] after:bg-[var(--app-brand)] hover:opacity-90 ${theme('action')}`, type: "button", children: [_jsx(Globe2, { className: "size-4" }), t('Publish')] })] }))] });
}
/** @param {{selectedGitRef?:string|null}} props */
export function SourceVersionMenu({ selectedGitRef = null }) {
    const t = filmT, gitVersions = exampleVersions, gitVersionsLoading = false, gitVersionError = null;
    return _jsxs("div", { className: "w-[280px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0", children: [_jsxs("button", { type: "button", className: "flex w-full items-center text-left h-9 cursor-pointer gap-2 rounded-md px-2.5 text-sm focus:bg-[var(--app-hover)]", disabled: !selectedGitRef, children: [_jsx("span", { className: "min-w-0 flex-1 truncate", children: "Latest" }), !selectedGitRef && _jsx("span", { className: "text-[11px] text-[var(--app-muted)]", children: t('Current') })] }), gitVersionsLoading && _jsx("div", { className: "px-2.5 py-2 text-xs text-[var(--app-muted)]", children: t('正在读取 Git 版本…') }), !gitVersionsLoading && gitVersions.length === 0 && _jsx("div", { className: "px-2.5 py-2 text-xs text-[var(--app-muted)]", children: t('暂无可切换的 Git 版本') }), !gitVersionsLoading && gitVersions.map((version) => (_jsx("button", { type: "button", className: "flex w-full items-center text-left h-auto min-h-9 cursor-pointer gap-2 rounded-md px-2.5 py-1.5 text-sm focus:bg-[var(--app-hover)]", children: _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate", children: version.message }), _jsxs("span", { className: "block text-[11px] text-[var(--app-muted)]", children: ["@", version.shortRef, version.current ? t(' · Current commit') : ''] })] }) }, version.ref))), gitVersionError && _jsx("div", { className: "px-2.5 py-2 text-xs text-[var(--app-danger)]", children: gitVersionError })] });
}
/** @param {{view?:string,children?:React.ReactNode,inspect?:boolean,selectedGitRef?:string|null}} props */
export function SourcePreviewCanvas({ view = 'browser', children, inspect = false, selectedGitRef = null }) {
    const browserMode = view === 'browser', workspaceView = view;
    const browserState = { address: 'forma.local', canGoBack: false, canGoForward: false, canInspect: true, externalUrl: 'http://forma.local', inspectMode: inspect, status: 'connected', surface: 'native-preview' };
    const browserWorkbenchRef = { current: null }, sessionId = 'film-session', projectName = 'Forma website', panelProps = {}, dataSurface = 'panel';
    const gitVersions = exampleVersions, gitVersionsLoading = false, gitVersionError = null, onSelectGitVersion = () => { }, onToggleDeviceView = () => { }, onBrowserStateChange = () => { }, t = filmT;
    return (_jsxs("div", { className: "flex size-full min-w-0 flex-col", children: [_jsx(BrowserNavigationBar, { browserState: browserState, browserWorkbenchRef: browserWorkbenchRef, gitVersionError: gitVersionError, gitVersions: gitVersions, gitVersionsLoading: gitVersionsLoading, selectedGitRef: selectedGitRef, workspaceView: view }), _jsx("main", { "aria-label": t('Preview canvas'), className: `relative min-h-0 min-w-0 flex-1 overflow-hidden ${browserMode ? theme('surface') : theme('editor')}`, children: _jsx("div", { className: browserMode ? 'size-full' : 'flex size-full items-center justify-center px-4 py-[46px]', children: _jsx("div", { className: browserMode ? 'size-full' : `h-full max-h-[835px] w-[391px] max-w-full overflow-hidden rounded-xl border shadow-[0_8px_16px_-4px_var(--app-shadow),0_24px_32px_-8px_var(--app-shadow)] ${theme('surface', 'border')}`, children: _jsx(SourceBrowserSurface, { children: children }) }) }) })] }));
}
export function SourceBrowserSurface({ children }) {
    return _jsx("section", { className: "flex size-full min-h-0 flex-col bg-[var(--app-background)] text-[var(--app-foreground)]", children: _jsx("div", { className: "relative min-h-0 flex-1 overflow-hidden bg-[var(--app-editor-background)]", children: children }) });
}
export function SourceInspectorOverlay({ bounds, label }) {
    const overlayStyle = bounds, selectedLabel = label;
    return _jsx("div", { className: `pointer-events-none absolute z-20 border-2 ${theme('inspector')}`, style: overlayStyle, children: _jsx("span", { className: `absolute bottom-full left-[-2px] max-w-64 truncate rounded-t px-1.5 py-0.5 text-[10px] leading-4 ${theme('inspectorLabel')}`, children: selectedLabel }) });
}

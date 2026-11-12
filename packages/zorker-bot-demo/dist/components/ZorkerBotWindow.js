import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { DemoCursor } from './DemoCursor';
import { ScreenOverlay } from './ScreenOverlay';
import { Sidebar } from './Sidebar';
import { SidePane } from './SidePane';
import { TrafficLights } from './TrafficLights';
import { Transcript } from './Transcript';
export function ZorkerBotWindow({ demo, rootSize, assetBase }) {
    const transcriptRef = useRef(null);
    useAutoScroll(transcriptRef, [demo.transcript, demo.pending]);
    const sidebarWidth = demo.sidePaneOpen ? 68 : 280;
    const activeAgent = { ...demo.activeAgent, name: demo.agentName };
    return (_jsx("div", { className: "zbd-root", "data-theme": "cursor-light", children: _jsxs("div", { className: "zbd-shell", children: [_jsx(TrafficLights, {}), _jsx("div", { className: "zbd-sidebar-slot", style: {
                        width: sidebarWidth,
                        transition: 'width .45s cubic-bezier(.22,1,.36,1)',
                    }, children: _jsx(Sidebar, { activeAgentName: demo.agentName, activePreview: demo.agentPreview, activeTime: demo.agentTime, assetBase: assetBase, collapsed: demo.sidePaneOpen }) }), _jsxs("div", { className: "zbd-chat", children: [_jsx("div", { className: "zbd-chat-header-wrap", children: _jsx(ChatHeader, { agent: activeAgent, assetBase: assetBase, computerOpen: demo.sidePaneOpen, onToggleComputer: demo.toggleComputer }) }), _jsx(Transcript, { assetBase: assetBase, cardStatus: demo.cardStatus, entries: demo.transcript, onFinishComputer: demo.finishTakeOver, onOpenComputer: () => demo.openScreen('entry'), onTakeOver: demo.takeOver, pending: demo.pending, screen: demo.screen, transcriptRef: transcriptRef }), _jsx(Composer, { agentName: demo.agentName })] }), demo.sidePaneOpen ? (_jsx(SidePane, { assetBase: assetBase, onClose: demo.closeComputer, onOpenScreen: () => demo.openScreen('pane'), screen: demo.screen })) : null, demo.overlay ? (_jsx(ScreenOverlay, { assetBase: assetBase, onClose: demo.closeScreen, onFinish: demo.finishTakeOver, overlay: demo.overlay, rootHeight: rootSize.height, rootWidth: rootSize.width, screen: demo.screen })) : null, _jsx(DemoCursor, { cursor: demo.cursor, ripples: demo.ripples })] }) }));
}

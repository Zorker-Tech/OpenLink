import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AgentAvatar } from './AgentAvatar';
import { MonitorIcon } from './icons';
export function ChatHeader({ agent, assetBase, computerOpen, onToggleComputer, }) {
    return (_jsxs("header", { className: "zbd-chat-header", children: [_jsx("div", { className: "zbd-chat-header-left", children: _jsxs("button", { "aria-label": `Open ${agent.name}'s computer`, className: "zbd-agent-title", onClick: onToggleComputer, type: "button", children: [_jsx(AgentAvatar, { agent: agent, assetBase: assetBase, size: 18 }), _jsx("span", { className: "zbd-agent-title-text", children: agent.name })] }) }), _jsx("div", { className: "zbd-chat-header-actions", children: _jsx("button", { "aria-label": computerOpen ? 'Hide computer' : 'Open computer', "aria-pressed": computerOpen, className: "zbd-icon-button", onClick: onToggleComputer, type: "button", children: _jsx(MonitorIcon, { size: 16 }) }) })] }));
}

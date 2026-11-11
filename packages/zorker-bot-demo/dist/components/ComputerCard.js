import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { RemoteDesktop } from '../remote-desktop/RemoteDesktop';
import { ComputerBadge } from './ComputerBadge';
export function ComputerCard({ entry, status, screen, assetBase, onOpen, onTakeOver, onFinish, }) {
    const isActionable = status === 'action-needed' || status === 'handed-over';
    const view = isActionable ? 'login' : 'portal';
    return (_jsx("div", { className: "zbd-card-wrap", children: _jsxs("div", { className: "zbd-card", children: [_jsxs("div", { className: "zbd-card-head", children: [_jsx("button", { className: "zbd-card-title", onClick: onOpen, type: "button", children: "Computer" }), _jsx("span", { className: "zbd-spacer" }), _jsx(ComputerBadge, { status: status })] }), _jsx("p", { className: "zbd-card-instruction", children: entry.instruction }), _jsx("div", { "aria-label": "Open Sales Outbound's computer", className: "zbd-card-thumb", "data-zbd-thumb": "computer", onClick: onOpen, onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onOpen();
                        }
                    }, role: "button", tabIndex: 0, children: _jsx(RemoteDesktop, { agentCursor: status === 'working', assetBase: assetBase, emailChars: screen.emailChars, focus: screen.focus, passwordChars: screen.passwordChars, showDock: false, view: view }) }), isActionable ? (_jsxs("div", { className: "zbd-card-actions", children: [_jsx("button", { className: "zbd-card-action", "data-zbd-target": "computer-take-over", "data-variant": "primary", onClick: onTakeOver, type: "button", children: "Take over" }), _jsx("button", { className: "zbd-card-action", "data-variant": "secondary", onClick: onFinish, type: "button", children: "I\u2019m done" })] })) : null] }) }));
}

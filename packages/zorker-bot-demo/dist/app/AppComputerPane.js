import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { RemoteDesktop } from '../remote-desktop/RemoteDesktop';
import { ClockIcon, CloseIcon, GearIcon } from '../components/icons';
import { DesktopPreview } from './DesktopPreview';
export function AppComputerPane({ session, displayName, assetBase, isSales, screen, onClose, onOpenScreen, }) {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [notifications, setNotifications] = useState(true);
    const [autoReview, setAutoReview] = useState(true);
    useEffect(() => {
        if (!settingsOpen)
            return;
        const close = (event) => {
            if (event.key === 'Escape')
                setSettingsOpen(false);
        };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [settingsOpen]);
    return (_jsx("aside", { className: "zbd-side-pane zbd-app-computer-pane", children: _jsxs("div", { className: "zbd-side-pane-inner", children: [_jsxs("header", { className: "zbd-side-pane-header", children: [_jsx("button", { "aria-label": "Agent settings", "aria-expanded": settingsOpen, className: "zbd-window-action", onClick: () => setSettingsOpen((open) => !open), type: "button", children: _jsx(GearIcon, { size: 15 }) }), _jsx("button", { "aria-label": "Close computer", className: "zbd-window-action", onClick: onClose, type: "button", children: _jsx(CloseIcon, { size: 14 }) })] }), _jsxs("div", { className: "zbd-side-pane-scroll", children: [_jsx("button", { "aria-label": `Open ${displayName}'s screen`, className: "zbd-side-preview zbd-app-side-preview", "data-zbd-thumb": isSales ? 'computer' : undefined, onClick: onOpenScreen, type: "button", children: isSales ? (_jsx(RemoteDesktop, { assetBase: assetBase, emailChars: screen.emailChars, focus: screen.focus, passwordChars: screen.passwordChars, showDock: false, view: screen.view })) : (_jsx(DesktopPreview, { assetBase: assetBase })) }), _jsxs("div", { className: "zbd-side-screen-label", children: [displayName, "\u2019s screen"] }), _jsx("div", { className: "zbd-side-section-title", children: "Routines" }), session.routines.length > 0 ? (session.routines.map((routine) => (_jsx(RoutineRow, { routine: routine }, routine.id)))) : (_jsxs("div", { className: "zbd-app-routine-empty", children: ["Nothing scheduled yet. Ask ", displayName, " to do something every morning and it shows up here."] }))] }), settingsOpen ? (_jsxs("div", { className: "zbd-app-settings", role: "dialog", children: [_jsxs("div", { className: "zbd-app-settings-head", children: [_jsxs("span", { children: [_jsx("strong", { children: displayName }), _jsx("small", { children: session.title })] }), _jsx("button", { "aria-label": "Close settings", className: "zbd-window-action", onClick: () => setSettingsOpen(false), type: "button", children: _jsx(CloseIcon, { size: 13 }) })] }), _jsx("p", { className: "zbd-app-settings-description", children: session.description }), _jsxs("div", { className: "zbd-app-settings-group", children: [_jsx(SettingToggle, { checked: notifications, label: "Notifications", description: "When this agent finishes or needs input", onChange: () => setNotifications((value) => !value) }), _jsx(SettingToggle, { checked: autoReview, label: "Auto review", description: "Check sensitive actions before they run", onChange: () => setAutoReview((value) => !value) })] })] })) : null] }) }));
}
function RoutineRow({ routine }) {
    return (_jsxs("div", { className: "zbd-routine-row zbd-app-routine-row", children: [_jsx("span", { className: "zbd-routine-icon", children: _jsx(ClockIcon, { size: 15 }) }), _jsxs("span", { className: "zbd-routine-copy", children: [_jsx("span", { children: routine.name }), _jsx("span", { children: routine.triggerDescription })] })] }));
}
function SettingToggle({ checked, label, description, onChange, }) {
    return (_jsxs("button", { "aria-checked": checked, className: "zbd-app-setting-toggle", onClick: onChange, role: "switch", type: "button", children: [_jsxs("span", { children: [_jsx("strong", { children: label }), _jsx("small", { children: description })] }), _jsx("span", { className: "zbd-app-switch", "data-on": checked ? '' : undefined, children: _jsx("span", {}) })] }));
}

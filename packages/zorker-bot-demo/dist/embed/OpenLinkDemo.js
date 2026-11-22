'use client';
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useLayoutEffect, useRef, useState, } from 'react';
import { AppCommandPalette } from '../app/AppCommandPalette';
import { AppComposer } from '../app/AppComposer';
import { AppTranscript } from '../app/AppTranscript';
import { OpenLinkAppShell, OpenLinkNavigationRail } from '../app/OpenLinkAppShell';
import { ClockIcon, MonitorIcon, SearchIcon } from '../components/icons';
import { END_SCREEN } from '../data/copy';
import { DemoInspector } from './DemoInspector';
import { activity, confirmation, message, scenarioIds, scenarios, scheduled, teamMembers } from './scenarios';
const paletteSessions = scenarioIds.map((id) => ({ session: scenarios[id].session, name: scenarios[id].session.name }));
const scenarioIcons = { computer: MonitorIcon, team: TeamIcon, routine: ClockIcon };
const stepLabels = {
    ready: 'Ready',
    running: 'Working',
    action: 'Waiting for you',
    control: 'You’re in control',
    done: 'Complete',
};
function TeamIcon({ size = 16 }) {
    return (_jsxs("svg", { "aria-hidden": "true", fill: "none", height: size, stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.3", viewBox: "0 0 16 16", width: size, children: [_jsx("circle", { cx: "6.1", cy: "5.1", r: "2.1" }), _jsx("path", { d: "M2 13v-1.4a3 3 0 0 1 3-3h2.2a3 3 0 0 1 3 3V13M10.1 3.2a2.1 2.1 0 0 1 0 4.1m1.1 1.5a3 3 0 0 1 2.8 3V13" })] }));
}
function BotMark({ scenario }) {
    const { name, ink } = scenarios[scenario].session;
    return _jsx("span", { "aria-hidden": "true", className: "oldemo-avatar", style: { backgroundColor: ink }, children: name[0] });
}
function workHandoff(scenario) {
    switch (scenario) {
        case 'computer':
            return [
                activity('open-queue', 'Opened the support queue', 'Harbor Support'),
                confirmation('takeover', 'Workspace access required', 'Take over the computer to grant read-only access to the sample queue.'),
            ];
        case 'team':
            return [
                message('agent-message', 'release', 'The release notes are ready. QA Bot, could you check the rollout checklist?', 'Release Bot'),
                message('agent-message', 'qa', 'The core flows passed. I’ve added a follow-up for large CSV exports.', 'QA Bot'),
                confirmation('approve', 'Review the launch handoff', 'Approve the draft or keep it for further review.'),
            ];
        case 'routine':
            return [
                activity('read-issues', 'Reviewed open product issues', '2 unassigned · 3 in progress'),
                confirmation('schedule', 'Choose a schedule', 'Run a weekly digest at 9:00 AM.'),
            ];
    }
}
function answered(entries) {
    return entries.map((entry) => entry.kind === 'confirmation'
        ? { ...entry, confirmation: { ...entry.confirmation, status: 'answered' } }
        : entry);
}
export function OpenLinkDemo({ className, initialScenario = 'computer', theme = 'auto' }) {
    const [scenario, setScenario] = useState(initialScenario);
    const [run, setRun] = useState(0);
    const choiceLabel = useId();
    return (_jsxs("div", { className: ['oldemo', className].filter(Boolean).join(' '), "data-oldemo-theme": theme, children: [_jsxs("div", { "aria-labelledby": choiceLabel, className: "oldemo-scenarios", role: "group", children: [_jsx("span", { className: "oldemo-sr", id: choiceLabel, children: "Choose a demo scenario" }), scenarioIds.map((id) => {
                        const Icon = scenarioIcons[id];
                        return (_jsxs("button", { "aria-pressed": scenario === id, onClick: () => setScenario(id), type: "button", children: [_jsx(Icon, {}), scenarios[id].label] }, id));
                    })] }), _jsx(DemoWorkspace, { onReset: () => setRun((value) => value + 1), onSelect: setScenario, scenario: scenario }, `${scenario}-${run}`), _jsxs("p", { className: "oldemo-caption", children: [scenarios[scenario].description, " ", _jsx("span", { children: "Simulated workspace" })] })] }));
}
function DemoWorkspace({ onReset, onSelect, scenario }) {
    const { session, prompt, followUp } = scenarios[scenario];
    const root = useRef(null);
    const transcript = useRef(null);
    const searchTrigger = useRef(null);
    const inspectorTrigger = useRef(null);
    const promptCounter = useRef(0);
    const [entries, setEntries] = useState(session.transcript);
    const [step, setStep] = useState('ready');
    const [draft, setDraft] = useState('');
    const [schedule, setSchedule] = useState('Every Monday');
    const [approved, setApproved] = useState(null);
    const [compact, setCompact] = useState(false);
    const [panel, setPanel] = useState(null);
    const [sidebar, setSidebar] = useState(null);
    const [palette, setPalette] = useState(false);
    const [query, setQuery] = useState('');
    const sidebarId = useId();
    const panelId = useId();
    const paneOpen = panel ?? !compact;
    const sidebarOpen = sidebar ?? !compact;
    const waiting = step === 'action' || step === 'control';
    useEffect(() => {
        const element = root.current;
        if (!element)
            return;
        const observer = new ResizeObserver(([entry]) => { if (entry)
            setCompact(entry.contentRect.width <= 760); });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        if (step !== 'running')
            return;
        const timeout = window.setTimeout(() => {
            setEntries((current) => [...current, ...workHandoff(scenario)]);
            setStep('action');
        }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 750);
        return () => window.clearTimeout(timeout);
    }, [scenario, step]);
    useLayoutEffect(() => {
        const element = transcript.current;
        if (element)
            element.scrollTop = element.scrollHeight;
    }, [entries, step]);
    function start(text) {
        setDraft('');
        setEntries((current) => [...current, message('user-message', 'prompt', text)]);
        setStep('running');
    }
    function send() {
        const text = draft.trim();
        if (!text)
            return;
        if (step === 'ready') {
            start(text);
            return;
        }
        if (step !== 'done')
            return;
        promptCounter.current += 1;
        const id = promptCounter.current;
        setDraft('');
        setEntries((current) => [
            ...current,
            message('user-message', `followup-${id}`, text),
            message('agent-message', `reply-${id}`, followUp, scenario === 'team' ? 'Release Bot' : undefined),
        ]);
    }
    function finish(result) {
        setEntries((current) => [...answered(current), ...result]);
        setStep('done');
    }
    function takeOver() {
        setStep('control');
        setPanel(true);
    }
    function resume() {
        finish([
            activity('read-queue', 'Read 3 tickets', '2 need replies today'),
            message('agent-message', 'result', '**Reply today**\n• OL-104 — Billing export stops on large reports.\n• OL-108 — Sign-in loops after switching workspaces.\n\nOL-112 can wait until tomorrow.'),
        ]);
        if (compact)
            closeInspector();
    }
    function decide(approve) {
        setApproved(approve);
        finish([message('agent-message', 'decision', approve
                ? 'Approved. The release notes, QA exceptions and owner are ready to share with Billing.'
                : 'I’ve kept the handoff in drafts with QA’s notes attached.', 'Release Bot')]);
    }
    function saveSchedule() {
        finish([
            scheduled(`${schedule} at 9:00 AM`),
            message('agent-message', 'result', `Scheduled for **${schedule.toLowerCase()} at 9:00 AM**. I’ll post the digest in this chat.`),
        ]);
    }
    function closeInspector() {
        setPanel(false);
        inspectorTrigger.current?.focus({ preventScroll: true });
    }
    function closePalette() {
        setPalette(false);
        setQuery('');
        searchTrigger.current?.focus({ preventScroll: true });
    }
    function pick(id) {
        if (id !== scenario)
            onSelect(id);
        else {
            if (palette)
                closePalette();
            if (compact)
                setSidebar(false);
        }
    }
    function onKeyDown(event) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            if (!palette)
                setPalette(true);
        }
        if (event.key === 'Escape' && paneOpen && compact && !palette)
            closeInspector();
    }
    return (_jsxs(OpenLinkAppShell, { "aria-label": "OpenLink Bot workspace demo", className: "oldemo-workspace zbd-root", "data-pane-default": panel === null, "data-sidebar-default": sidebar === null, navigation: _jsxs(_Fragment, { children: [_jsxs(OpenLinkNavigationRail, { "aria-label": "Demo workspace navigation", className: "oldemo-rail", footer: _jsx("span", { "aria-label": "Demo account", className: "oldemo-account", role: "img", children: "OL" }), children: [_jsx("button", { "aria-controls": sidebarId, "aria-expanded": sidebarOpen, "aria-label": "Bot conversations", className: "oldemo-icon", onClick: () => setSidebar(!sidebarOpen), title: "Bot conversations", type: "button", children: _jsx(TeamIcon, { size: 18 }) }), _jsx("button", { "aria-label": "Find a Bot", className: "oldemo-icon", onClick: () => setPalette(true), ref: searchTrigger, title: "Find a Bot", type: "button", children: _jsx(SearchIcon, { size: 18 }) })] }), _jsxs("aside", { "aria-label": "Bot conversations", className: "oldemo-sidebar", hidden: !sidebarOpen, id: sidebarId, children: [_jsx("strong", { children: "Conversations" }), scenarioIds.map((id) => (_jsxs("button", { "aria-current": scenario === id ? 'true' : undefined, onClick: () => pick(id), type: "button", children: [_jsx(BotMark, { scenario: id }), _jsxs("span", { children: [scenarios[id].session.name, _jsx("small", { children: scenarios[id].label })] })] }, id)))] })] }), onKeyDown: onKeyDown, overlay: palette ? (_jsx(AppCommandPalette, { assetBase: "", onClose: closePalette, onQueryChange: setQuery, onSelect: (id) => pick(id), query: query, scopeKeyboard: true, sessions: paletteSessions })) : null, ref: root, role: "region", children: [_jsxs("section", { "aria-label": session.name, className: "oldemo-conversation zbd-chat zbd-app-chat", children: [_jsxs("header", { className: "oldemo-chat-heading", children: [_jsx(BotMark, { scenario: scenario }), _jsxs("div", { children: [_jsx("strong", { children: session.name }), _jsx("span", { "aria-live": "polite", className: "oldemo-status", "data-step": step, children: stepLabels[step] })] }), _jsx("button", { "aria-controls": panelId, "aria-expanded": paneOpen, "aria-label": scenario === 'computer' ? 'Bot computer' : 'Task details', className: "oldemo-icon", onClick: () => setPanel(!paneOpen), ref: inspectorTrigger, type: "button", children: _jsx(MonitorIcon, { size: 17 }) })] }), _jsx(AppTranscript, { assetBase: "", cardStatus: "done", displayName: session.name, entries: entries, locale: "en-US", onFinishComputer: resume, onOpenComputer: () => setPanel(true), onSuggestion: setDraft, onTakeOver: takeOver, pending: step === 'running' ? { label: 'Checking the workspace', showLabel: true } : null, screen: END_SCREEN, session: session, transcriptRef: transcript }), step === 'ready' || step === 'done' || waiting ? (_jsxs("div", { className: "oldemo-actions", children: [step === 'ready' ? _jsxs("button", { className: "oldemo-primary", onClick: () => start(prompt), type: "button", children: [_jsx("span", { "aria-hidden": "true", children: "\u25B6" }), " Play demo"] }) : null, step === 'done' ? _jsx("button", { className: "oldemo-secondary", onClick: onReset, type: "button", children: "Reset demo" }) : null, step === 'action' && scenario === 'computer' ? _jsx("button", { className: "oldemo-primary", onClick: takeOver, type: "button", children: "Take over computer" }) : null, step === 'control' ? _jsx("button", { className: "oldemo-secondary", onClick: () => setPanel(true), type: "button", children: "Show computer" }) : null, step === 'action' && scenario === 'team' ? (_jsxs(_Fragment, { children: [_jsx("button", { className: "oldemo-primary", onClick: () => decide(true), type: "button", children: "Approve handoff" }), _jsx("button", { className: "oldemo-secondary", onClick: () => decide(false), type: "button", children: "Keep as draft" })] })) : null, step === 'action' && scenario === 'routine' ? (_jsxs(_Fragment, { children: [_jsxs("select", { "aria-label": "Schedule day", onChange: (event) => setSchedule(event.target.value), value: schedule, children: [_jsx("option", { children: "Every Monday" }), _jsx("option", { children: "Every Friday" })] }), _jsx("button", { className: "oldemo-primary", onClick: saveSchedule, type: "button", children: "Save routine" })] })) : null] })) : null, _jsx(AppComposer, { disabled: step === 'running' || waiting, displayName: session.name, groupMembers: scenario === 'team' ? teamMembers : undefined, onChange: setDraft, onSend: send, showRoutine: false, showVoice: false, value: draft })] }), _jsx("div", { className: "oldemo-pane", hidden: !paneOpen, id: panelId, children: _jsx(DemoInspector, { approved: approved, onClose: closeInspector, onResume: resume, onTakeOver: takeOver, open: paneOpen, scenario: scenario, schedule: schedule, step: step }) })] }));
}

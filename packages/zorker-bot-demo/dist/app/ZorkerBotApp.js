'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState, } from 'react';
import { DemoCursor } from '../components/DemoCursor';
import { ScreenOverlay } from '../components/ScreenOverlay';
import { TrafficLights } from '../components/TrafficLights';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useDemoSequence } from '../hooks/useDemoSequence';
import { wait } from '../lib/dom';
import { AppChatHeader } from './AppChatHeader';
import { AppCommandPalette } from './AppCommandPalette';
import { AppComputerPane } from './AppComputerPane';
import { AppComposer } from './AppComposer';
import { AppScreenLightbox } from './AppScreenLightbox';
import { AppSidebar } from './AppSidebar';
import { AppTranscript } from './AppTranscript';
import { APP_NOW, createInitialSessions, createNewAgentSession, entryPreview, formatSidebarTime, isSessionMatch, replyForSession, sessionActivityMs, sessionPreview, titleFromMessage, transcriptTimestamp, uniqueEntryId, } from './data';
export function ZorkerBotApp({ assetBase = '/zorker-bot-demo', autoPlayIntro = true, className, }) {
    const rootRef = useRef(null);
    const transcriptRef = useRef(null);
    const rootSize = useElementSize(rootRef);
    const demo = useDemoSequence(rootRef);
    const { applyEndState, cancel, start } = demo;
    const [sessions, setSessions] = useState(createInitialSessions);
    const [activeId, setActiveId] = useState('sales-outbound');
    const [search, setSearch] = useState('');
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [paletteQuery, setPaletteQuery] = useState('');
    const [computerOpen, setComputerOpen] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [extras, setExtras] = useState({});
    const [pendingMap, setPendingMap] = useState({});
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [newAgentSequence, setNewAgentSequence] = useState(1);
    const [backTarget, setBackTarget] = useState(null);
    const activeSession = sessions.find((session) => session.id === activeId) ?? sessions[0];
    const isSales = activeId === 'sales-outbound';
    const displayName = isSales ? demo.agentName : activeSession.name;
    const activeExtras = extras[activeId] ?? [];
    const activeEntries = useMemo(() => [
        ...(isSales ? demo.transcript : activeSession.transcript),
        ...activeExtras,
    ], [activeExtras, activeSession.transcript, demo.transcript, isSales]);
    const activePending = isSales
        ? demo.pending
        : (pendingMap[activeId] ?? null);
    const introRunning = isSales && demo.pending !== null;
    const composerDisabled = introRunning || sending;
    const lastSalesExtra = extras['sales-outbound']?.at(-1);
    const salesPreview = lastSalesExtra
        ? entryPreview(lastSalesExtra) || demo.agentPreview
        : demo.agentPreview;
    const salesTime = lastSalesExtra
        ? formatSidebarTime(transcriptTimestamp(lastSalesExtra) ?? Date.now())
        : demo.transcript.length === 0
            ? formatSidebarTime(APP_NOW)
            : demo.agentTime;
    const rows = sessions.map((session) => {
        const sessionExtras = extras[session.id] ?? [];
        const rowIsSales = session.id === 'sales-outbound';
        return {
            session,
            name: rowIsSales ? demo.agentName : session.name,
            preview: rowIsSales
                ? salesPreview
                : sessionPreview(session, sessionExtras),
            time: rowIsSales
                ? salesTime
                : formatSidebarTime(sessionActivityMs(session, sessionExtras)),
            unread: session.unread,
        };
    });
    const filteredRows = rows.filter((row) => isSessionMatch(row.session, search, row.name));
    const paletteSessions = rows.map(({ session, name }) => ({
        session,
        name,
    }));
    useAutoScroll(transcriptRef, [
        activeId,
        activeEntries.length,
        activePending,
        displayName,
    ]);
    useEffect(() => {
        if (!autoPlayIntro) {
            applyEndState();
            return;
        }
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            applyEndState();
            return;
        }
        const timer = window.setTimeout(() => {
            void start();
        }, 30);
        return () => window.clearTimeout(timer);
    }, [applyEndState, autoPlayIntro, start]);
    useEffect(() => () => cancel(), [cancel]);
    const skipIntro = useCallback(() => {
        applyEndState();
        setDraft('');
    }, [applyEndState]);
    const openPalette = useCallback(() => {
        if (introRunning)
            applyEndState();
        setComputerOpen(false);
        setLightboxOpen(false);
        setPaletteOpen(true);
        setPaletteQuery('');
    }, [applyEndState, introRunning]);
    const closePalette = useCallback(() => {
        setPaletteOpen(false);
        setPaletteQuery('');
    }, []);
    const selectSession = useCallback((sessionId) => {
        if (sessionId !== 'sales-outbound' && introRunning) {
            applyEndState();
        }
        setActiveId(sessionId);
        setSessions((previous) => previous.map((session) => session.id === sessionId
            ? { ...session, unread: false, unreadCount: 0 }
            : session));
        setBackTarget(null);
        setDraft('');
        setLightboxOpen(false);
        setPaletteOpen(false);
        setPaletteQuery('');
    }, [applyEndState, introRunning]);
    const createAgent = useCallback((query = '') => {
        if (introRunning)
            applyEndState();
        const sequence = newAgentSequence;
        setNewAgentSequence((value) => value + 1);
        const session = createNewAgentSession(sequence);
        const cleanQuery = query.trim();
        if (cleanQuery) {
            session.name = titleFromMessage(cleanQuery);
            session.title = session.name;
        }
        setSessions((previous) => [session, ...previous]);
        setBackTarget(activeId);
        setActiveId(session.id);
        setDraft('');
        setComputerOpen(false);
        setPaletteOpen(false);
        setPaletteQuery('');
        setSearch('');
    }, [activeId, applyEndState, introRunning, newAgentSequence]);
    const goBack = useCallback(() => {
        const target = backTarget ?? 'sales-outbound';
        const current = sessions.find((session) => session.id === activeId);
        const currentExtras = extras[activeId] ?? [];
        if (current?.isDraft && currentExtras.length === 0) {
            setSessions((previous) => previous.filter((session) => session.id !== activeId));
        }
        setActiveId(target);
        setBackTarget(null);
        setDraft('');
        setComputerOpen(false);
        setLightboxOpen(false);
    }, [activeId, backTarget, extras, sessions]);
    const toggleComputer = useCallback(() => {
        setComputerOpen((open) => !open);
        setLightboxOpen(false);
    }, []);
    const openScreen = useCallback(() => {
        if (isSales) {
            demo.openScreen('pane');
        }
        else {
            setLightboxOpen(true);
        }
    }, [demo, isSales]);
    const openComputerFromCard = useCallback(() => {
        if (isSales) {
            demo.openScreen('entry');
        }
        else {
            setLightboxOpen(true);
        }
    }, [demo, isSales]);
    const sendMessage = useCallback(async () => {
        const content = draft.trim();
        if (!content || sending || introRunning)
            return;
        const sessionId = activeId;
        const session = sessions.find((item) => item.id === sessionId) ?? activeSession;
        const userEntry = {
            kind: 'user-message',
            id: uniqueEntryId('user'),
            content,
            timestampMs: Date.now(),
        };
        setSending(true);
        setDraft('');
        setExtras((previous) => ({
            ...previous,
            [sessionId]: [...(previous[sessionId] ?? []), userEntry],
        }));
        setSessions((previous) => previous.map((item) => {
            if (item.id !== sessionId)
                return item;
            if (!item.isDraft)
                return item;
            const nextName = titleFromMessage(content);
            return { ...item, name: nextName, title: nextName, isDraft: false };
        }));
        setPendingMap((previous) => ({
            ...previous,
            [sessionId]: { label: 'Thinking', showLabel: true },
        }));
        await wait(900);
        const replyEntry = {
            kind: 'agent-message',
            id: uniqueEntryId('agent'),
            content: replyForSession(session, content),
            timestampMs: Date.now(),
            author: session.isGroup
                ? { id: 'chief-of-staff', name: 'Chief' }
                : undefined,
        };
        setExtras((previous) => ({
            ...previous,
            [sessionId]: [...(previous[sessionId] ?? []), replyEntry],
        }));
        setPendingMap((previous) => ({ ...previous, [sessionId]: null }));
        setSending(false);
    }, [
        activeId,
        activeSession,
        draft,
        introRunning,
        sending,
        sessions,
    ]);
    const createRoutine = useCallback(() => {
        if (introRunning)
            return;
        const routine = {
            id: uniqueEntryId('routine'),
            name: 'Weekly follow-up',
            triggerDescription: 'Mondays at 9:00 AM',
        };
        const entry = {
            kind: 'system',
            id: uniqueEntryId('system'),
            timestampMs: Date.now(),
            event: {
                type: 'created-routine',
                name: routine.name,
                triggerDescription: routine.triggerDescription,
            },
        };
        setExtras((previous) => ({
            ...previous,
            [activeId]: [...(previous[activeId] ?? []), entry],
        }));
        setSessions((previous) => previous.map((session) => session.id === activeId
            ? { ...session, routines: [...session.routines, routine] }
            : session));
    }, [activeId, introRunning]);
    const useSuggestion = useCallback((suggestion) => {
        setDraft(suggestion);
        window.requestAnimationFrame(() => {
            document
                .querySelector('.zbd-app-composer-input')
                ?.focus();
        });
    }, []);
    useEffect(() => {
        const onKeyDown = (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                openPalette();
            }
            if (event.key === 'Escape') {
                setPaletteOpen(false);
                setLightboxOpen(false);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [openPalette]);
    const sidebarWidth = computerOpen ? 68 : 280;
    const showBack = Boolean(backTarget) || activeSession.id.startsWith('new-agent');
    return (_jsx("div", { className: `zbd-root zbd-app-root ${className ?? ''}`, "data-active-session": activeId, "data-theme": "cursor-light", ref: rootRef, children: _jsxs("div", { className: "zbd-shell zbd-app-shell", children: [_jsx(TrafficLights, {}), _jsx("div", { className: "zbd-sidebar-slot zbd-app-sidebar-slot", style: {
                        width: sidebarWidth,
                        transition: 'width .45s cubic-bezier(.22,1,.36,1)',
                    }, children: _jsx(AppSidebar, { activeId: activeId, assetBase: assetBase, collapsed: computerOpen, onNewAgent: openPalette, onSearch: setSearch, onSearchFocus: () => {
                            if (introRunning)
                                applyEndState();
                        }, onSelect: selectSession, rows: filteredRows, search: search }) }), _jsxs("div", { className: "zbd-chat zbd-app-chat", children: [_jsx("div", { className: "zbd-chat-header-wrap", children: _jsx(AppChatHeader, { assetBase: assetBase, computerOpen: computerOpen, displayName: displayName, introRunning: introRunning, onBack: goBack, onSkipIntro: skipIntro, onToggleComputer: toggleComputer, session: activeSession, showBack: showBack }) }), _jsx(AppTranscript, { assetBase: assetBase, cardStatus: demo.cardStatus, displayName: displayName, entries: activeEntries, onFinishComputer: demo.finishTakeOver, onOpenComputer: openComputerFromCard, onSuggestion: useSuggestion, onTakeOver: demo.takeOver, pending: activePending, screen: demo.screen, session: activeSession, transcriptRef: transcriptRef }, activeId), _jsx(AppComposer, { disabled: composerDisabled, displayName: displayName, onChange: setDraft, onCreateRoutine: createRoutine, onSend: () => {
                                void sendMessage();
                            }, value: draft })] }), computerOpen ? (_jsx(AppComputerPane, { assetBase: assetBase, displayName: displayName, isSales: isSales, onClose: () => setComputerOpen(false), onOpenScreen: openScreen, screen: demo.screen, session: activeSession }, `${activeId}-computer`)) : null, isSales && demo.overlay && rootSize.width > 0 ? (_jsx(ScreenOverlay, { assetBase: assetBase, onClose: demo.closeScreen, onFinish: demo.finishTakeOver, overlay: demo.overlay, rootHeight: rootSize.height, rootWidth: rootSize.width, screen: demo.screen })) : null, lightboxOpen && !isSales ? (_jsx(AppScreenLightbox, { assetBase: assetBase, displayName: displayName, onClose: () => setLightboxOpen(false) })) : null, paletteOpen ? (_jsx(AppCommandPalette, { assetBase: assetBase, onClose: closePalette, onCreate: createAgent, onQueryChange: setPaletteQuery, onSelect: selectSession, query: paletteQuery, sessions: paletteSessions })) : null, _jsx(DemoCursor, { cursor: demo.cursor, ripples: demo.ripples })] }) }));
}
function useElementSize(ref) {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const element = ref.current;
        if (!element)
            return;
        const update = () => {
            const rect = element.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

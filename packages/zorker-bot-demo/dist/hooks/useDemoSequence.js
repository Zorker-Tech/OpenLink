var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { useCallback, useRef, useState } from 'react';
import { CHECKING_CONNECTIONS, COMPUTER_ASK, COMPUTER_INSTRUCTION, CONNECTED_SUMMARY, CONTEXT_MESSAGE, DONE_MESSAGE, DRAFTS_MESSAGE, EMAIL, END_SCREEN, GREETING, INITIAL_SCREEN, PASSWORD_LENGTH, ROUTINE, SEND_MESSAGE, USER_REQUEST, } from '../data/copy';
import { ACTIVE_AGENT } from '../data/agents';
import { FINAL_TRANSCRIPT } from '../data/transcript';
import { formatTime } from '../lib/format-time';
import { uniqueId } from '../lib/ids';
import { messageDelay } from '../lib/message-delay';
import { stripMarkdown } from '../lib/rich-text';
import { wait } from '../lib/dom';
import { useCursor } from './useCursor';
export function useDemoSequence(rootRef) {
    const { cursor: cursorState, ripples, reset: resetCursor, showAt, moveToTarget, click, hide: hideCursor, waitForTarget, } = useCursor(rootRef);
    const [agentName, setAgentName] = useState('New agent');
    const [agentPreview, setAgentPreview] = useState('Typing…');
    const [agentTime, setAgentTime] = useState('3:26 AM');
    const [transcript, setTranscript] = useState([]);
    const [pending, setPending] = useState({ label: null, showLabel: false });
    const [screen, setScreen] = useState(INITIAL_SCREEN);
    const [overlay, setOverlay] = useState(null);
    const [cardStatus, setCardStatus] = useState('action-needed');
    const [sidePaneOpen, setSidePaneOpen] = useState(false);
    const runIdRef = useRef(0);
    const startedRef = useRef(false);
    const applyEndState = useCallback(() => {
        runIdRef.current += 1;
        startedRef.current = true;
        setAgentName('Sales Outbound');
        setAgentPreview(DONE_MESSAGE);
        setAgentTime(formatTime(Date.now()));
        setTranscript(FINAL_TRANSCRIPT);
        setPending(null);
        setScreen(END_SCREEN);
        setCardStatus('done');
        setOverlay(null);
        setSidePaneOpen(false);
        resetCursor();
    }, [resetCursor]);
    const finishTakeOver = useCallback(() => {
        setCardStatus('working');
        setScreen((previous) => (Object.assign(Object.assign({}, previous), { isWorking: true })));
        window.setTimeout(() => {
            setOverlay(null);
            window.setTimeout(() => setCardStatus('done'), 800);
        }, 250);
    }, []);
    const start = useCallback(() => __awaiter(this, void 0, void 0, function* () {
        if (startedRef.current)
            return;
        startedRef.current = true;
        resetCursor();
        const id = ++runIdRef.current;
        const alive = () => runIdRef.current === id;
        const add = (entry) => {
            if (alive())
                setTranscript((previous) => [...previous, entry]);
        };
        const preview = (text) => {
            if (alive())
                setAgentPreview(stripMarkdown(text));
        };
        const stamp = () => Date.now();
        const showPending = (label, totalMs) => {
            if (!alive())
                return;
            setPending({ label, showLabel: false });
            if (totalMs > 0) {
                window.setTimeout(() => {
                    if (alive())
                        setPending((previous) => (previous ? Object.assign(Object.assign({}, previous), { showLabel: true }) : previous));
                }, Math.max(0, totalMs - 900));
            }
        };
        const agentMessage = (content_1, ...args_1) => __awaiter(this, [content_1, ...args_1], void 0, function* (content, label = null) {
            const totalMs = messageDelay(content);
            showPending(label, totalMs);
            yield wait(totalMs);
            if (!alive())
                return;
            add({
                kind: 'agent-message',
                id: uniqueId('agent'),
                content,
                timestampMs: stamp(),
            });
            setPending(null);
            setAgentTime(formatTime(stamp()));
            preview(content);
        });
        const userMessage = (content) => {
            add({
                kind: 'user-message',
                id: uniqueId('user'),
                content,
                timestampMs: stamp(),
            });
            setAgentTime(formatTime(stamp()));
            preview(content);
        };
        setPending({ label: null, showLabel: false });
        yield wait(250);
        if (!alive())
            return;
        yield agentMessage(GREETING, 'Spawning');
        if (!alive())
            return;
        yield wait(900);
        if (!alive())
            return;
        userMessage(USER_REQUEST);
        yield wait(500);
        if (!alive())
            return;
        setAgentName('Sales Outbound');
        add({
            kind: 'system',
            id: uniqueId('rename'),
            event: { type: 'renamed', name: 'Sales Outbound' },
            timestampMs: stamp(),
        });
        yield wait(300);
        if (!alive())
            return;
        yield agentMessage(CHECKING_CONNECTIONS, 'Checking connections');
        if (!alive())
            return;
        yield wait(350);
        if (!alive())
            return;
        setCardStatus('action-needed');
        setScreen(INITIAL_SCREEN);
        add({
            kind: 'computer',
            id: 'computer-1',
            instruction: COMPUTER_INSTRUCTION,
            ask: COMPUTER_ASK,
            status: 'action-needed',
            screenKind: 'crm-portal',
            timestampMs: stamp(),
        });
        preview(CHECKING_CONNECTIONS);
        try {
            yield wait(1400);
            if (!alive())
                return;
            const takeOver = yield waitForTarget('computer-take-over');
            const root = rootRef.current;
            if (root) {
                const rootRect = root.getBoundingClientRect();
                const rect = takeOver.getBoundingClientRect();
                yield showAt(rect.left - rootRect.left + rect.width * 0.5 + 56, rect.top - rootRect.top + rect.height * 0.55 + 44);
            }
            yield moveToTarget(takeOver);
            yield click(() => setCardStatus('handed-over'));
            yield wait(220);
            if (!alive())
                return;
            setOverlay({ mode: 'takeover', origin: 'entry', instruction: COMPUTER_ASK });
            yield wait(650);
            if (!alive())
                return;
            const emailField = yield waitForTarget('portal-email');
            yield moveToTarget(emailField, 0.25);
            yield click(() => setScreen(Object.assign(Object.assign({}, INITIAL_SCREEN), { emailChars: 5, focus: 'email' })));
            for (const count of [10, EMAIL.length]) {
                if (!alive())
                    return;
                setScreen(Object.assign(Object.assign({}, INITIAL_SCREEN), { emailChars: count, focus: 'email' }));
                yield wait(70);
            }
            if (!alive())
                return;
            setScreen(Object.assign(Object.assign({}, INITIAL_SCREEN), { emailChars: EMAIL.length, passwordChars: PASSWORD_LENGTH, focus: 'password' }));
            yield wait(120);
            const submit = yield waitForTarget('portal-submit');
            yield moveToTarget(submit);
            yield click(() => setScreen(Object.assign(Object.assign({}, END_SCREEN), { view: 'portal', isWorking: false })));
            yield wait(850);
            if (!alive())
                return;
            const done = yield waitForTarget('screen-done');
            yield moveToTarget(done);
            yield click(() => finishTakeOver());
            yield wait(400);
            if (!alive())
                return;
            hideCursor();
            yield wait(1000);
            if (!alive())
                return;
        }
        catch (_a) {
            if (!alive())
                return;
            setOverlay(null);
        }
        yield wait(1500);
        if (!alive())
            return;
        yield agentMessage(CONNECTED_SUMMARY, 'Wrapping the run');
        if (!alive())
            return;
        yield wait(800);
        if (!alive())
            return;
        setCardStatus('done');
        yield wait(700);
        if (!alive())
            return;
        yield wait(900);
        if (!alive())
            return;
        add({
            kind: 'system',
            id: uniqueId('context'),
            event: {
                type: 'received-context',
                sources: [{ name: 'Account Manager' }, { name: 'Chief' }],
            },
            timestampMs: stamp(),
        });
        setAgentPreview('Messages from Account Manager and Chief');
        setAgentTime(formatTime(stamp()));
        yield wait(600);
        if (!alive())
            return;
        yield agentMessage(CONTEXT_MESSAGE, 'Receiving context');
        if (!alive())
            return;
        yield wait(900);
        if (!alive())
            return;
        yield agentMessage(DRAFTS_MESSAGE, 'Drafting');
        if (!alive())
            return;
        yield wait(1400);
        if (!alive())
            return;
        userMessage(SEND_MESSAGE);
        yield wait(700);
        if (!alive())
            return;
        setTranscript((previous) => {
            var _a;
            var _b;
            const next = [...previous];
            for (let index = next.length - 1; index >= 0; index -= 1) {
                const entry = next[index];
                if (entry.kind === 'user-message') {
                    next[index] = Object.assign(Object.assign({}, entry), { reactions: ((_a = entry.reactions) === null || _a === void 0 ? void 0 : _a.includes('👍'))
                            ? entry.reactions
                            : [...((_b = entry.reactions) !== null && _b !== void 0 ? _b : []), '👍'] });
                    break;
                }
            }
            return next;
        });
        yield wait(700);
        if (!alive())
            return;
        add({
            kind: 'system',
            id: uniqueId('routine'),
            event: Object.assign({ type: 'created-routine' }, ROUTINE),
            timestampMs: stamp(),
        });
        setAgentPreview(`Created routine ${ROUTINE.name}`);
        yield wait(300);
        if (!alive())
            return;
        yield agentMessage(DONE_MESSAGE);
        if (!alive())
            return;
        setPending(null);
        setCardStatus('done');
    }), [
        click,
        finishTakeOver,
        hideCursor,
        moveToTarget,
        resetCursor,
        rootRef,
        showAt,
        waitForTarget,
    ]);
    const takeOver = useCallback(() => {
        setCardStatus('handed-over');
        setOverlay({ mode: 'takeover', origin: 'entry', instruction: COMPUTER_ASK });
    }, []);
    const openScreen = useCallback((origin = 'entry') => {
        setOverlay({ mode: 'lightbox', origin });
    }, []);
    const closeScreen = useCallback(() => setOverlay(null), []);
    const toggleComputer = useCallback(() => setSidePaneOpen((previous) => !previous), []);
    const closeComputer = useCallback(() => setSidePaneOpen(false), []);
    const cancel = useCallback(() => {
        runIdRef.current += 1;
        startedRef.current = false;
    }, []);
    return {
        agentName,
        agentPreview,
        agentTime,
        activeAgent: ACTIVE_AGENT,
        transcript,
        pending,
        screen,
        overlay,
        cardStatus,
        sidePaneOpen,
        cursor: cursorState,
        ripples,
        start,
        applyEndState,
        finishTakeOver,
        takeOver,
        openScreen,
        closeScreen,
        toggleComputer,
        closeComputer,
        cancel,
    };
}

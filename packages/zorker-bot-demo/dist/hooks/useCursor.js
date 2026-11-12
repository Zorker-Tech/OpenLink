import { useCallback, useRef, useState } from 'react';
import { rootPoint, wait, waitForTarget as waitForTargetInRoot } from '../lib/dom';
export function useCursor(rootRef) {
    const [cursor, setCursor] = useState({ x: 0, y: 0, duration: 0, visible: false });
    const [ripples, setRipples] = useState([]);
    const cursorRef = useRef(cursor);
    const rippleIdRef = useRef(0);
    cursorRef.current = cursor;
    const moveTo = useCallback((x, y, immediate = false) => {
        const previous = cursorRef.current;
        const distance = Math.hypot(x - previous.x, y - previous.y);
        const duration = immediate ? 0 : Math.round(Math.min(850, Math.max(320, 1.05 * distance)));
        const next = { x, y, duration, visible: true };
        cursorRef.current = next;
        setCursor(next);
        return duration;
    }, []);
    const showAt = useCallback(async (x, y) => {
        moveTo(x, y, true);
        await wait(350);
    }, [moveTo]);
    const moveToTarget = useCallback(async (element, xRatio = 0.5, yRatio = 0.55) => {
        const root = rootRef.current;
        if (!root)
            return;
        const point = rootPoint(root, element, xRatio, yRatio);
        const duration = moveTo(point.x, point.y);
        await wait(duration + 80);
    }, [moveTo, rootRef]);
    const click = useCallback(async (action) => {
        const point = cursorRef.current;
        const ripple = { id: (rippleIdRef.current += 1), x: point.x, y: point.y };
        setRipples((previous) => [...previous, ripple]);
        window.setTimeout(() => setRipples((previous) => previous.filter((item) => item.id !== ripple.id)), 450);
        await wait(140);
        action();
        await wait(180);
    }, []);
    const hide = useCallback(() => {
        setCursor((previous) => ({ ...previous, visible: false }));
    }, []);
    const reset = useCallback(() => {
        setCursor({ x: 0, y: 0, duration: 0, visible: false });
        setRipples([]);
    }, []);
    const waitForTarget = useCallback(async (name, timeoutMs = 15_000) => {
        const root = rootRef.current;
        if (!root)
            throw new Error('Zorker Bot demo root is not mounted');
        return waitForTargetInRoot(root, name, timeoutMs);
    }, [rootRef]);
    return {
        cursor,
        ripples,
        moveTo,
        showAt,
        moveToTarget,
        click,
        hide,
        reset,
        waitForTarget,
    };
}

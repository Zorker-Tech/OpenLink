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
    const showAt = useCallback((x, y) => __awaiter(this, void 0, void 0, function* () {
        moveTo(x, y, true);
        yield wait(350);
    }), [moveTo]);
    const moveToTarget = useCallback((element_1, ...args_1) => __awaiter(this, [element_1, ...args_1], void 0, function* (element, xRatio = 0.5, yRatio = 0.55) {
        const root = rootRef.current;
        if (!root)
            return;
        const point = rootPoint(root, element, xRatio, yRatio);
        const duration = moveTo(point.x, point.y);
        yield wait(duration + 80);
    }), [moveTo, rootRef]);
    const click = useCallback((action) => __awaiter(this, void 0, void 0, function* () {
        const point = cursorRef.current;
        const ripple = { id: (rippleIdRef.current += 1), x: point.x, y: point.y };
        setRipples((previous) => [...previous, ripple]);
        window.setTimeout(() => setRipples((previous) => previous.filter((item) => item.id !== ripple.id)), 450);
        yield wait(140);
        action();
        yield wait(180);
    }), []);
    const hide = useCallback(() => {
        setCursor((previous) => (Object.assign(Object.assign({}, previous), { visible: false })));
    }, []);
    const reset = useCallback(() => {
        setCursor({ x: 0, y: 0, duration: 0, visible: false });
        setRipples([]);
    }, []);
    const waitForTarget = useCallback((name_1, ...args_1) => __awaiter(this, [name_1, ...args_1], void 0, function* (name, timeoutMs = 15000) {
        const root = rootRef.current;
        if (!root)
            throw new Error('Zorker Bot demo root is not mounted');
        return waitForTargetInRoot(root, name, timeoutMs);
    }), [rootRef]);
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

'use client';
import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect } from 'react';
import { ZorkerBotWindow } from './components/ZorkerBotWindow';
import { DEMO_HEIGHT, DEMO_WIDTH } from './data/copy';
import { useDemoSequence } from './hooks/useDemoSequence';
import { useStageScale } from './hooks/useStageScale';
export function ZorkerBotDemo({ assetBase = '/zorker-bot-demo', autoStart = true, className, }) {
    const { outerRef, rootRef, scale, rootSize } = useStageScale();
    const demo = useDemoSequence(rootRef);
    const { applyEndState, cancel, start } = demo;
    useEffect(() => {
        const root = rootRef.current;
        if (!root)
            return;
        const completeOnInteraction = () => applyEndState();
        root.addEventListener('pointerdown', completeOnInteraction, { capture: true });
        return () => root.removeEventListener('pointerdown', completeOnInteraction, { capture: true });
    }, [applyEndState, rootRef]);
    useEffect(() => {
        if (!autoStart)
            return;
        const node = outerRef.current;
        if (!node)
            return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            applyEndState();
            return;
        }
        let started = false;
        const observer = new IntersectionObserver((entries) => {
            if (started)
                return;
            if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.35)) {
                started = true;
                observer.disconnect();
                void start();
            }
        }, { threshold: [0.35] });
        observer.observe(node);
        return () => {
            observer.disconnect();
            cancel();
        };
    }, [applyEndState, autoStart, cancel, outerRef, start]);
    return (_jsx("div", { className: `zbd-stage-outer ${className ?? ''}`, ref: outerRef, style: { height: DEMO_HEIGHT * scale }, children: _jsx("div", { className: "zbd-stage", ref: rootRef, style: {
                height: DEMO_HEIGHT,
                transform: `scale(${scale})`,
                width: DEMO_WIDTH,
            }, children: _jsx(ZorkerBotWindow, { assetBase: assetBase, demo: demo, rootSize: rootSize }) }) }));
}

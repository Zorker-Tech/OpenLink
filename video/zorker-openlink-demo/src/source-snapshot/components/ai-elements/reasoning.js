"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, } from "../ui/collapsible.js";
import { cn } from "../../lib/utils.js";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, } from "react";
import { Streamdown } from "streamdown";
import { Shimmer } from "./shimmer.js";
const ReasoningContext = createContext(null);
export const useReasoning = () => {
    const context = useContext(ReasoningContext);
    if (!context) {
        throw new Error("Reasoning components must be used within Reasoning");
    }
    return context;
};
const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;
export const Reasoning = memo(({ className, isStreaming = false, open, defaultOpen, onOpenChange, duration: durationProp, children, ...props }) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    // Track if defaultOpen was explicitly set to false (to prevent auto-open)
    const isExplicitlyClosed = defaultOpen === false;
    const [isOpen, setIsOpen] = useControllableState({
        defaultProp: resolvedDefaultOpen,
        onChange: onOpenChange,
        prop: open,
    });
    const [duration, setDuration] = useControllableState({
        defaultProp: undefined,
        prop: durationProp,
    });
    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const startTimeRef = useRef(null);
    // Track when streaming starts and compute duration
    useEffect(() => {
        if (isStreaming) {
            hasEverStreamedRef.current = true;
            if (startTimeRef.current === null) {
                startTimeRef.current = Date.now();
            }
        }
        else if (startTimeRef.current !== null) {
            setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
            startTimeRef.current = null;
        }
    }, [isStreaming, setDuration]);
    // Auto-open when streaming starts (unless explicitly closed)
    useEffect(() => {
        if (isStreaming && !isOpen && !isExplicitlyClosed) {
            setIsOpen(true);
        }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);
    // Auto-close when streaming ends (once only, and only if it ever streamed)
    useEffect(() => {
        if (hasEverStreamedRef.current &&
            !isStreaming &&
            isOpen &&
            !hasAutoClosed) {
            const timer = setTimeout(() => {
                setIsOpen(false);
                setHasAutoClosed(true);
            }, AUTO_CLOSE_DELAY);
            return () => clearTimeout(timer);
        }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);
    const handleOpenChange = useCallback((newOpen) => {
        setIsOpen(newOpen);
    }, [setIsOpen]);
    const contextValue = useMemo(() => ({ duration, isOpen, isStreaming, setIsOpen }), [duration, isOpen, isStreaming, setIsOpen]);
    return (_jsx(ReasoningContext.Provider, { value: contextValue, children: _jsx(Collapsible, { className: cn("not-prose mb-4", className), onOpenChange: handleOpenChange, open: isOpen, ...props, children: children }) }));
});
const defaultGetThinkingMessage = (isStreaming, duration) => {
    if (isStreaming || duration === 0) {
        return _jsx(Shimmer, { duration: 1, children: "Thinking..." });
    }
    if (duration === undefined) {
        return _jsx("p", { children: "Thought for a few seconds" });
    }
    return _jsxs("p", { children: ["Thought for ", duration, " seconds"] });
};
export const ReasoningTrigger = memo(({ className, children, getThinkingMessage = defaultGetThinkingMessage, ...props }) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    return (_jsx(CollapsibleTrigger, { "data-no-press-motion": true, className: cn("flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground", className), ...props, children: children ?? (_jsxs(_Fragment, { children: [_jsx(BrainIcon, { className: "size-4" }), getThinkingMessage(isStreaming, duration), _jsx(ChevronDownIcon, { className: cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0") })] })) }));
});
const streamdownPlugins = { cjk, code, math, mermaid };
export const ReasoningContent = memo(({ className, children, ...props }) => (_jsx(CollapsibleContent, { className: cn("mt-4 text-sm", "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in", className), ...props, children: _jsx(Streamdown, { plugins: streamdownPlugins, children: children }) })));
Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";

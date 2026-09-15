"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from "../ui/button.js";
import { ButtonGroup, ButtonGroupText, } from "../ui/button-group.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "../ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, } from "react";
import { Streamdown } from "streamdown";
export const Message = ({ className, from, ...props }) => (_jsx("div", { className: cn("group flex w-full max-w-[95%] flex-col gap-2", from === "user" ? "is-user ml-auto justify-end" : "is-assistant", className), ...props }));
export const MessageContent = ({ children, className, ...props }) => (_jsx("div", { className: cn("is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm", "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground", "group-[.is-assistant]:text-foreground", className), ...props, children: children }));
export const MessageActions = ({ className, children, ...props }) => (_jsx("div", { className: cn("flex items-center gap-1", className), ...props, children: children }));
export const MessageAction = ({ tooltip, children, label, variant = "ghost", size = "icon-sm", ...props }) => {
    const button = (_jsxs(Button, { size: size, type: "button", variant: variant, ...props, children: [children, _jsx("span", { className: "sr-only", children: label || tooltip })] }));
    if (tooltip) {
        return (_jsx(TooltipProvider, { children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { children: button }), _jsx(TooltipContent, { children: _jsx("p", { children: tooltip }) })] }) }));
    }
    return button;
};
const MessageBranchContext = createContext(null);
const useMessageBranch = () => {
    const context = useContext(MessageBranchContext);
    if (!context) {
        throw new Error("MessageBranch components must be used within MessageBranch");
    }
    return context;
};
export const MessageBranch = ({ defaultBranch = 0, onBranchChange, className, ...props }) => {
    const [currentBranch, setCurrentBranch] = useState(defaultBranch);
    const [branches, setBranches] = useState([]);
    const handleBranchChange = useCallback((newBranch) => {
        setCurrentBranch(newBranch);
        onBranchChange?.(newBranch);
    }, [onBranchChange]);
    const goToPrevious = useCallback(() => {
        const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
        handleBranchChange(newBranch);
    }, [currentBranch, branches.length, handleBranchChange]);
    const goToNext = useCallback(() => {
        const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
        handleBranchChange(newBranch);
    }, [currentBranch, branches.length, handleBranchChange]);
    const contextValue = useMemo(() => ({
        branches,
        currentBranch,
        goToNext,
        goToPrevious,
        setBranches,
        totalBranches: branches.length,
    }), [branches, currentBranch, goToNext, goToPrevious]);
    return (_jsx(MessageBranchContext.Provider, { value: contextValue, children: _jsx("div", { className: cn("grid w-full gap-2 [&>div]:pb-0", className), ...props }) }));
};
export const MessageBranchContent = ({ children, ...props }) => {
    const { currentBranch, setBranches, branches } = useMessageBranch();
    const childrenArray = useMemo(() => (Array.isArray(children) ? children : [children]), [children]);
    // Use useEffect to update branches when they change
    useEffect(() => {
        if (branches.length !== childrenArray.length) {
            setBranches(childrenArray);
        }
    }, [childrenArray, branches, setBranches]);
    return childrenArray.map((branch, index) => (_jsx("div", { className: cn("grid gap-2 overflow-hidden [&>div]:pb-0", index === currentBranch ? "block" : "hidden"), ...props, children: branch }, branch.key)));
};
export const MessageBranchSelector = ({ className, ...props }) => {
    const { totalBranches } = useMessageBranch();
    // Don't render if there's only one branch
    if (totalBranches <= 1) {
        return null;
    }
    return (_jsx(ButtonGroup, { className: cn("[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md", className), orientation: "horizontal", ...props }));
};
export const MessageBranchPrevious = ({ children, ...props }) => {
    const { goToPrevious, totalBranches } = useMessageBranch();
    return (_jsx(Button, { "aria-label": "Previous branch", disabled: totalBranches <= 1, onClick: goToPrevious, size: "icon-sm", type: "button", variant: "ghost", ...props, children: children ?? _jsx(ChevronLeftIcon, { size: 14 }) }));
};
export const MessageBranchNext = ({ children, ...props }) => {
    const { goToNext, totalBranches } = useMessageBranch();
    return (_jsx(Button, { "aria-label": "Next branch", disabled: totalBranches <= 1, onClick: goToNext, size: "icon-sm", type: "button", variant: "ghost", ...props, children: children ?? _jsx(ChevronRightIcon, { size: 14 }) }));
};
export const MessageBranchPage = ({ className, ...props }) => {
    const { currentBranch, totalBranches } = useMessageBranch();
    return (_jsxs(ButtonGroupText, { className: cn("border-none bg-transparent text-muted-foreground shadow-none", className), ...props, children: [currentBranch + 1, " of ", totalBranches] }));
};
const streamdownPlugins = { cjk, code, math, mermaid };
export const MessageResponse = memo(({ className, ...props }) => {
    const responseId = useId().replace(/:/g, "");
    // Streamdown intentionally renders a document-style card around tables.
    // Chat messages already provide the grouping, so flatten that wrapper
    // without adding another DOM container around the response itself.
    useLayoutEffect(() => {
        const root = document.querySelector(`[data-openlink-message-response="${responseId}"]`);
        if (!root)
            return;
        const flattenTables = () => {
            for (const wrapper of root.querySelectorAll('[data-streamdown="table-wrapper"]')) {
                Object.assign(wrapper.style, {
                    margin: "0",
                    gap: "0",
                    border: "0",
                    borderRadius: "0",
                    background: "transparent",
                    padding: "0",
                });
                const tableContainer = wrapper.lastElementChild;
                if (tableContainer instanceof HTMLElement) {
                    Object.assign(tableContainer.style, { border: "0", borderRadius: "0", background: "transparent" });
                }
            }
        };
        flattenTables();
        const observer = new MutationObserver(flattenTables);
        observer.observe(root, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [responseId, props.children]);
    return (_jsx(Streamdown, { className: cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className), "data-openlink-message-response": responseId, 
        // Streamdown's built-in link safety dialog is rendered alongside the
        // link. Inside Markdown paragraphs that produces invalid nested block
        // elements and hydration failures. Links remain sanitized and open
        // with rel=noreferrer through Streamdown's normal anchor renderer.
        linkSafety: { enabled: false }, plugins: streamdownPlugins, ...props }));
}, (prevProps, nextProps) => prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating);
MessageResponse.displayName = "MessageResponse";
export const MessageToolbar = ({ className, children, ...props }) => (_jsx("div", { className: cn("mt-4 flex w-full items-center justify-between gap-4", className), ...props, children: children }));

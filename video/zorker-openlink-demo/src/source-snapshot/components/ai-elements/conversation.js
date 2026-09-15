"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Button } from "../ui/button.js";
import { cn } from "../../lib/utils.js";
import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
export const Conversation = ({ className, ...props }) => (_jsx(StickToBottom, { className: cn("relative flex-1 overflow-y-hidden", className), initial: "smooth", resize: "smooth", role: "log", ...props }));
export const ConversationContent = ({ className, ...props }) => (_jsx(StickToBottom.Content, { className: cn("flex flex-col gap-8 p-4", className), ...props }));
export const ConversationEmptyState = ({ className, title = "No messages yet", description = "Start a conversation to see messages here", icon, children, ...props }) => (_jsx("div", { className: cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className), ...props, children: children ?? (_jsxs(_Fragment, { children: [icon && _jsx("div", { className: "text-muted-foreground", children: icon }), _jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "font-medium text-sm", children: title }), description && (_jsx("p", { className: "text-muted-foreground text-sm", children: description }))] })] })) }));
export const ConversationScrollButton = ({ className, ...props }) => {
    const { isAtBottom, scrollToBottom } = useStickToBottomContext();
    const handleScrollToBottom = useCallback(() => {
        scrollToBottom();
    }, [scrollToBottom]);
    return (!isAtBottom && (_jsx(Button, { className: cn("absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted", className), onClick: handleScrollToBottom, size: "icon", type: "button", variant: "outline", ...props, children: _jsx(ArrowDownIcon, { className: "size-4" }) })));
};
const getMessageText = (message) => message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
const defaultFormatMessage = (message) => {
    const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
    return `**${roleLabel}:** ${getMessageText(message)}`;
};
export const messagesToMarkdown = (messages, formatMessage = defaultFormatMessage) => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");
export const ConversationDownload = ({ messages, filename = "conversation.md", formatMessage = defaultFormatMessage, className, children, ...props }) => {
    const handleDownload = useCallback(() => {
        const markdown = messagesToMarkdown(messages, formatMessage);
        const blob = new Blob([markdown], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }, [messages, filename, formatMessage]);
    return (_jsx(Button, { className: cn("absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted", className), onClick: handleDownload, size: "icon", type: "button", variant: "outline", ...props, children: children ?? _jsx(DownloadIcon, { className: "size-4" }) }));
};

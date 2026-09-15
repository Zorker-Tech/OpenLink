'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.js";
import { Hand, ShieldCheck, Unlock } from 'lucide-react';
const OPTIONS = [
    { value: 'restricted', label: '受控', description: '仅只读操作，走防护墙', icon: ShieldCheck },
    { value: 'ask', label: '询问', description: '写操作需用户确认', icon: Hand },
    { value: 'open', label: '开放', description: '完全访问，不做限制', icon: Unlock },
];
function currentOption(value) {
    return OPTIONS.find((option) => option.value === value) ?? OPTIONS[0];
}
/**
 * Bare-icon access-mode control for the left of the composer. Uses the shared
 * DropdownMenu (anchored + portaled to body) so the drawer is never clipped by
 * the composer's overflow, and opens upward with the full option names.
 */
export function AccessModePicker({ value, onChange, }) {
    const active = currentOption(value);
    const ActiveIcon = active.icon;
    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { render: _jsx("button", { "aria-label": `访问模式：${active.label}（${active.description}）`, className: "flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]", title: `${active.label}：${active.description}`, type: "button" }), children: _jsx(ActiveIcon, { className: "size-3.5" }) }), _jsx(DropdownMenuContent, { align: "start", className: "w-[190px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)]", side: "top", children: OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const selected = option.value === value;
                    return (_jsxs(DropdownMenuItem, { "aria-pressed": selected, className: `h-9 cursor-pointer gap-2 rounded-md px-2 text-left ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] focus:bg-[var(--app-hover)] focus:text-[var(--app-foreground)]'}`, onSelect: () => onChange(option.value), children: [_jsx(Icon, { className: "size-3.5 shrink-0" }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-[12px] font-medium", children: option.label }), _jsx("span", { className: "block truncate text-[10px] text-[var(--app-subtle-foreground)]", children: option.description })] })] }, option.value));
                }) })] }));
}

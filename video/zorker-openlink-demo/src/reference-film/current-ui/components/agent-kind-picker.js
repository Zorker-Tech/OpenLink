'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useT } from "../lib/i18n/client.js";
import { Bot, Check, Sparkles } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, } from "./ui/dropdown-menu.js";
import { useState } from 'react';
function agentKindOptions(t) {
    return [
        { value: 'codex', label: 'Codex', description: t('OpenAI Codex · 默认 Agent，自带沙箱') },
        { value: 'pi', label: 'Pi', description: t('Pi coding agent · 浏览器与 Supabase 扩展') },
    ];
}
export function AgentKindPicker({ value, onChange }) {
    const [open, setOpen] = useState(false);
    const t = useT();
    const options = agentKindOptions(t);
    const active = options.find((option) => option.value === value) ?? options[0];
    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { render: _jsx("button", { "aria-label": t('Agent：{label}（{description}）', { label: active.label, description: active.description }), className: "flex h-[22px] items-center rounded-md px-1 text-[12px] font-medium text-[var(--app-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]", title: t('{label}：{description}', { label: active.label, description: active.description }), type: "button" }), children: _jsx("span", { children: active.label }) }), _jsx(DropdownMenuContent, { align: "start", className: "w-[240px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 text-[var(--app-foreground)] shadow-[0_10px_28px_var(--app-shadow)]", side: "bottom", children: options.map((option) => {
                    const selected = option.value === value;
                    const Icon = option.value === 'codex' ? Sparkles : Bot;
                    return (_jsxs(DropdownMenuItem, { className: `h-9 cursor-pointer gap-2.5 rounded-md px-2.5 text-sm ${selected ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] focus:bg-[var(--app-hover)]'}`, onClick: () => onChange(option.value), children: [_jsx(Icon, { className: "size-4 text-[var(--app-muted)]" }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block text-[13px] leading-4", children: option.label }), _jsx("span", { className: "block truncate text-[11px] text-[var(--app-subtle)]", children: option.description })] }), selected && _jsx(Check, { className: "size-4 shrink-0 text-[var(--app-foreground)]" })] }, option.value));
                }) })] }));
}

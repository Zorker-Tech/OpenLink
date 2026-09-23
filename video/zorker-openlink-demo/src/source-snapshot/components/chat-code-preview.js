'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import { useT } from "../lib/i18n/client.js";
/**
 * A deliberately small, read-only Monaco surface for the message timeline.
 * The full code-server workbench remains the editing destination; this view is
 * only the live source snapshot attached to the corresponding file task.
 */
export function ChatCodePreview({ path, content, language = 'plaintext', className = '', streaming = false }) {
    const hostRef = useRef(null);
    const modelRef = useRef(null);
    const editorRef = useRef(null);
    const contentRef = useRef(content);
    contentRef.current = content;
    const t = useT();
    useEffect(() => {
        let disposed = false;
        void import('monaco-editor').then((module) => {
            if (disposed || !hostRef.current)
                return;
            const uri = module.Uri.parse(`inmemory://openlink/chat/${encodeURIComponent(path)}`);
            const model = module.editor.createModel(contentRef.current, language, uri);
            const theme = document.querySelector('[data-theme]')?.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
            const editor = module.editor.create(hostRef.current, {
                automaticLayout: true,
                ariaLabel: `${path} code preview`,
                folding: false,
                lineDecorationsWidth: 8,
                lineNumbers: 'on',
                minimap: { enabled: false },
                model,
                padding: { top: 8, bottom: 8 },
                readOnly: true,
                renderLineHighlight: 'none',
                scrollBeyondLastLine: false,
                scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                theme,
                wordWrap: 'on',
            });
            if (disposed) {
                editor.dispose();
                model.dispose();
                return;
            }
            modelRef.current = model;
            editorRef.current = editor;
        }).catch(() => {
            // The task card still renders its path/status if Monaco cannot load in a
            // constrained browser context. The full code-server view is unaffected.
        });
        return () => {
            disposed = true;
            editorRef.current?.dispose();
            modelRef.current?.dispose();
            editorRef.current = null;
            modelRef.current = null;
        };
    }, [language, path]);
    useEffect(() => {
        const model = modelRef.current;
        if (model && model.getValue() !== content)
            model.setValue(content);
    }, [content]);
    return (_jsxs("div", { className: `relative min-w-0 overflow-hidden rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] ${className}`, "data-code-preview": path, children: [_jsxs("div", { className: "flex h-6 items-center justify-between border-b border-[var(--app-control-border)] px-2 text-[11px] text-[var(--app-muted)]", children: [_jsx("span", { className: "min-w-0 truncate font-mono", children: path }), streaming ? _jsx("span", { className: "shrink-0 text-[var(--app-subtle-foreground)]", children: t('正在编辑') }) : null] }), _jsx("div", { className: "h-[220px] w-full", ref: hostRef })] }));
}

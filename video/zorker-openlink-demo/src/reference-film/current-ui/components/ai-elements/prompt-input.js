"use client";
import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, } from "../ui/command.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, } from "../ui/dropdown-menu.js";
import { HoverCard, HoverCardContent, HoverCardTrigger, } from "../ui/hover-card.js";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea, } from "../ui/input-group.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "../ui/select.js";
import { Spinner } from "../ui/spinner.js";
import { Tooltip, TooltipContent, TooltipTrigger, } from "../ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import { shouldSubmitPromptOnEnter } from "../../lib/prompt-keyboard.js";
import { CornerDownLeftIcon, ImageIcon, FolderUp, Monitor, PlusIcon, SquareIcon, XIcon, } from "lucide-react";
import { nanoid } from "nanoid";
import { Children, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, } from "react";
// ============================================================================
// Helpers
// ============================================================================
const convertBlobUrlToDataUrl = async (url) => {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        // FileReader uses callback-based API, wrapping in Promise is necessary
        // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
        return new Promise((resolve) => {
            const reader = new FileReader();
            // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
            reader.onloadend = () => resolve(reader.result);
            // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    }
    catch {
        return null;
    }
};
const captureScreenshot = async () => {
    if (typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getDisplayMedia) {
        return null;
    }
    let stream = null;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            audio: false,
            video: true,
        });
        video.srcObject = stream;
        // Video element uses callback-based API, wrapping in Promise is necessary
        // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
        await new Promise((resolve, reject) => {
            // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
            video.onloadedmetadata = () => resolve();
            // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
            video.onerror = () => reject(new Error("Failed to load screen stream"));
        });
        await video.play();
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) {
            return null;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
            return null;
        }
        context.drawImage(video, 0, 0, width, height);
        // canvas.toBlob uses callback-based API, wrapping in Promise is necessary
        // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
        const blob = await new Promise((resolve) => {
            canvas.toBlob(resolve, "image/png");
        });
        if (!blob) {
            return null;
        }
        const timestamp = new Date()
            .toISOString()
            .replaceAll(/[:.]/g, "-")
            .replace("T", "_")
            .replace("Z", "");
        return new File([blob], `screenshot-${timestamp}.png`, {
            lastModified: Date.now(),
            type: "image/png",
        });
    }
    finally {
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }
        video.pause();
        video.srcObject = null;
    }
};
const PromptInputController = createContext(null);
const ProviderAttachmentsContext = createContext(null);
export const usePromptInputController = () => {
    const ctx = useContext(PromptInputController);
    if (!ctx) {
        throw new Error("Wrap your component inside <PromptInputProvider> to use usePromptInputController().");
    }
    return ctx;
};
// Optional variants (do NOT throw). Useful for dual-mode components.
const useOptionalPromptInputController = () => useContext(PromptInputController);
export const useProviderAttachments = () => {
    const ctx = useContext(ProviderAttachmentsContext);
    if (!ctx) {
        throw new Error("Wrap your component inside <PromptInputProvider> to use useProviderAttachments().");
    }
    return ctx;
};
const useOptionalProviderAttachments = () => useContext(ProviderAttachmentsContext);
/**
 * Optional global provider that lifts PromptInput state outside of PromptInput.
 * If you don't use it, PromptInput stays fully self-managed.
 */
export const PromptInputProvider = ({ initialInput: initialTextInput = "", children, }) => {
    // ----- textInput state
    const [textInput, setTextInput] = useState(initialTextInput);
    const clearInput = useCallback(() => setTextInput(""), []);
    // ----- attachments state (global when wrapped)
    const [attachmentFiles, setAttachmentFiles] = useState([]);
    const fileInputRef = useRef(null);
    // oxlint-disable-next-line eslint(no-empty-function)
    const openRef = useRef(() => { });
    const add = useCallback((files) => {
        const incoming = [...files];
        if (incoming.length === 0) {
            return;
        }
        const batchId = crypto.randomUUID();
        setAttachmentFiles((prev) => [
            ...prev,
            ...incoming.map((file) => ({
                batchId,
                filename: file.name,
                id: nanoid(),
                mediaType: file.type,
                relativePath: file.webkitRelativePath || undefined,
                type: "file",
                uploadId: crypto.randomUUID(),
                url: URL.createObjectURL(file),
            })),
        ]);
    }, []);
    const remove = useCallback((id) => {
        setAttachmentFiles((prev) => {
            const found = prev.find((f) => f.id === id);
            if (found?.url) {
                URL.revokeObjectURL(found.url);
            }
            return prev.filter((f) => f.id !== id);
        });
    }, []);
    const clear = useCallback(() => {
        setAttachmentFiles((prev) => {
            for (const f of prev) {
                if (f.url) {
                    URL.revokeObjectURL(f.url);
                }
            }
            return [];
        });
    }, []);
    // Keep a ref to attachments for cleanup on unmount (avoids stale closure)
    const attachmentsRef = useRef(attachmentFiles);
    useEffect(() => {
        attachmentsRef.current = attachmentFiles;
    }, [attachmentFiles]);
    // Cleanup blob URLs on unmount to prevent memory leaks
    useEffect(() => () => {
        for (const f of attachmentsRef.current) {
            if (f.url) {
                URL.revokeObjectURL(f.url);
            }
        }
    }, []);
    const openFileDialog = useCallback(() => {
        openRef.current?.();
    }, []);
    const attachments = useMemo(() => ({
        add,
        clear,
        fileInputRef,
        files: attachmentFiles,
        openFileDialog,
        remove,
    }), [attachmentFiles, add, remove, clear, openFileDialog]);
    const __registerFileInput = useCallback((ref, open) => {
        fileInputRef.current = ref.current;
        openRef.current = open;
    }, []);
    const controller = useMemo(() => ({
        __registerFileInput,
        attachments,
        textInput: {
            clear: clearInput,
            setInput: setTextInput,
            value: textInput,
        },
    }), [textInput, clearInput, attachments, __registerFileInput]);
    return (_jsx(PromptInputController.Provider, { value: controller, children: _jsx(ProviderAttachmentsContext.Provider, { value: attachments, children: children }) }));
};
// ============================================================================
// Component Context & Hooks
// ============================================================================
const LocalAttachmentsContext = createContext(null);
export const usePromptInputAttachments = () => {
    // Prefer local context (inside PromptInput) as it has validation, fall back to provider
    const provider = useOptionalProviderAttachments();
    const local = useContext(LocalAttachmentsContext);
    const context = local ?? provider;
    if (!context) {
        throw new Error("usePromptInputAttachments must be used within a PromptInput or PromptInputProvider");
    }
    return context;
};
export const LocalReferencedSourcesContext = createContext(null);
export const usePromptInputReferencedSources = () => {
    const ctx = useContext(LocalReferencedSourcesContext);
    if (!ctx) {
        throw new Error("usePromptInputReferencedSources must be used within a LocalReferencedSourcesContext.Provider");
    }
    return ctx;
};
export const PromptInputActionAddAttachments = ({ children, label = "Add photos or files", ...props }) => {
    const attachments = usePromptInputAttachments();
    const handleClick = useCallback(() => {
        attachments.openFileDialog();
    }, [attachments]);
    return (_jsx(DropdownMenuItem, { ...props, onClick: handleClick, children: children ?? (_jsxs(_Fragment, { children: [_jsx(ImageIcon, { className: "mr-2 size-4" }), " ", label] })) }));
};
export const PromptInputActionAddFolder = ({ children, label = "Upload folder", ...props }) => {
    const attachments = usePromptInputAttachments();
    const inputRef = useRef(null);
    return (_jsxs(_Fragment, { children: [_jsx("input", { "aria-label": label, className: "hidden", multiple: true, onChange: (event) => {
                    if (event.currentTarget.files?.length)
                        attachments.add(event.currentTarget.files);
                    event.currentTarget.value = "";
                }, ref: inputRef, type: "file", ...{ webkitdirectory: "", directory: "" } }), _jsx(DropdownMenuItem, { ...props, onClick: () => inputRef.current?.click(), children: children ?? _jsxs(_Fragment, { children: [_jsx(FolderUp, { className: "mr-2 size-4" }), " ", label] }) })] }));
};
export const PromptInputActionAddScreenshot = ({ label = "Take screenshot", onSelect, ...props }) => {
    const attachments = usePromptInputAttachments();
    const handleSelect = useCallback(async (event) => {
        onSelect?.(event);
        if (event.defaultPrevented) {
            return;
        }
        try {
            const screenshot = await captureScreenshot();
            if (screenshot) {
                attachments.add([screenshot]);
            }
        }
        catch (error) {
            if (error instanceof DOMException &&
                (error.name === "NotAllowedError" || error.name === "AbortError")) {
                return;
            }
            throw error;
        }
    }, [onSelect, attachments]);
    return (_jsxs(DropdownMenuItem, { ...props, onSelect: handleSelect, children: [_jsx(Monitor, { className: "mr-2 size-4" }), label] }));
};
export const PromptInput = ({ className, accept, multiple, globalDrop, syncHiddenInput, maxFiles, maxFileSize, onError, onSubmit, children, ...props }) => {
    // Try to use a provider controller if present
    const controller = useOptionalPromptInputController();
    const usingProvider = !!controller;
    // Refs
    const inputRef = useRef(null);
    const formRef = useRef(null);
    // ----- Local attachments (only used when no provider)
    const [items, setItems] = useState([]);
    const files = usingProvider ? controller.attachments.files : items;
    // ----- Local referenced sources (always local to PromptInput)
    const [referencedSources, setReferencedSources] = useState([]);
    // Keep a ref to files for cleanup on unmount (avoids stale closure)
    const filesRef = useRef(files);
    useEffect(() => {
        filesRef.current = files;
    }, [files]);
    const openFileDialogLocal = useCallback(() => {
        inputRef.current?.click();
    }, []);
    const matchesAccept = useCallback((f) => {
        if (!accept || accept.trim() === "") {
            return true;
        }
        const patterns = accept
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        return patterns.some((pattern) => {
            if (pattern.endsWith("/*")) {
                // e.g: image/* -> image/
                const prefix = pattern.slice(0, -1);
                return f.type.startsWith(prefix);
            }
            return f.type === pattern;
        });
    }, [accept]);
    const addLocal = useCallback((fileList) => {
        const incoming = [...fileList];
        const accepted = incoming.filter((f) => matchesAccept(f));
        if (incoming.length && accepted.length === 0) {
            onError?.({
                code: "accept",
                message: "No files match the accepted types.",
            });
            return;
        }
        const withinSize = (f) => maxFileSize ? f.size <= maxFileSize : true;
        const sized = accepted.filter(withinSize);
        if (accepted.length > 0 && sized.length === 0) {
            onError?.({
                code: "max_file_size",
                message: "All files exceed the maximum size.",
            });
            return;
        }
        setItems((prev) => {
            const capacity = typeof maxFiles === "number"
                ? Math.max(0, maxFiles - prev.length)
                : undefined;
            const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized;
            if (typeof capacity === "number" && sized.length > capacity) {
                onError?.({
                    code: "max_files",
                    message: "Too many files. Some were not added.",
                });
            }
            const next = [];
            const batchId = crypto.randomUUID();
            for (const file of capped) {
                next.push({
                    batchId,
                    filename: file.name,
                    id: nanoid(),
                    mediaType: file.type,
                    relativePath: file.webkitRelativePath || undefined,
                    type: "file",
                    uploadId: crypto.randomUUID(),
                    url: URL.createObjectURL(file),
                });
            }
            return [...prev, ...next];
        });
    }, [matchesAccept, maxFiles, maxFileSize, onError]);
    const removeLocal = useCallback((id) => setItems((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) {
            URL.revokeObjectURL(found.url);
        }
        return prev.filter((file) => file.id !== id);
    }), []);
    // Wrapper that validates files before calling provider's add
    const addWithProviderValidation = useCallback((fileList) => {
        const incoming = [...fileList];
        const accepted = incoming.filter((f) => matchesAccept(f));
        if (incoming.length && accepted.length === 0) {
            onError?.({
                code: "accept",
                message: "No files match the accepted types.",
            });
            return;
        }
        const withinSize = (f) => maxFileSize ? f.size <= maxFileSize : true;
        const sized = accepted.filter(withinSize);
        if (accepted.length > 0 && sized.length === 0) {
            onError?.({
                code: "max_file_size",
                message: "All files exceed the maximum size.",
            });
            return;
        }
        const currentCount = files.length;
        const capacity = typeof maxFiles === "number"
            ? Math.max(0, maxFiles - currentCount)
            : undefined;
        const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized;
        if (typeof capacity === "number" && sized.length > capacity) {
            onError?.({
                code: "max_files",
                message: "Too many files. Some were not added.",
            });
        }
        if (capped.length > 0) {
            controller?.attachments.add(capped);
        }
    }, [matchesAccept, maxFileSize, maxFiles, onError, files.length, controller]);
    const clearAttachments = useCallback(() => usingProvider
        ? controller?.attachments.clear()
        : setItems((prev) => {
            for (const file of prev) {
                if (file.url) {
                    URL.revokeObjectURL(file.url);
                }
            }
            return [];
        }), [usingProvider, controller]);
    const clearReferencedSources = useCallback(() => setReferencedSources([]), []);
    const add = usingProvider ? addWithProviderValidation : addLocal;
    const remove = usingProvider ? controller.attachments.remove : removeLocal;
    const openFileDialog = usingProvider
        ? controller.attachments.openFileDialog
        : openFileDialogLocal;
    const clear = useCallback(() => {
        clearAttachments();
        clearReferencedSources();
    }, [clearAttachments, clearReferencedSources]);
    // Let provider know about our hidden file input so external menus can call openFileDialog()
    useEffect(() => {
        if (!usingProvider) {
            return;
        }
        controller.__registerFileInput(inputRef, () => inputRef.current?.click());
    }, [usingProvider, controller]);
    // Note: File input cannot be programmatically set for security reasons
    // The syncHiddenInput prop is no longer functional
    useEffect(() => {
        if (syncHiddenInput && inputRef.current && files.length === 0) {
            inputRef.current.value = "";
        }
    }, [files, syncHiddenInput]);
    // Attach drop handlers on nearest form and document (opt-in)
    useEffect(() => {
        const form = formRef.current;
        if (!form) {
            return;
        }
        if (globalDrop) {
            // when global drop is on, let the document-level handler own drops
            return;
        }
        const onDragOver = (e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
            }
        };
        const onDrop = (e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
            }
            if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
                add(e.dataTransfer.files);
            }
        };
        form.addEventListener("dragover", onDragOver);
        form.addEventListener("drop", onDrop);
        return () => {
            form.removeEventListener("dragover", onDragOver);
            form.removeEventListener("drop", onDrop);
        };
    }, [add, globalDrop]);
    useEffect(() => {
        if (!globalDrop) {
            return;
        }
        const onDragOver = (e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
            }
        };
        const onDrop = (e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
            }
            if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
                add(e.dataTransfer.files);
            }
        };
        document.addEventListener("dragover", onDragOver);
        document.addEventListener("drop", onDrop);
        return () => {
            document.removeEventListener("dragover", onDragOver);
            document.removeEventListener("drop", onDrop);
        };
    }, [add, globalDrop]);
    useEffect(() => () => {
        if (!usingProvider) {
            for (const f of filesRef.current) {
                if (f.url) {
                    URL.revokeObjectURL(f.url);
                }
            }
        }
    }, [usingProvider]);
    const handleChange = useCallback((event) => {
        if (event.currentTarget.files) {
            add(event.currentTarget.files);
        }
        // Reset input value to allow selecting files that were previously removed
        event.currentTarget.value = "";
    }, [add]);
    const attachmentsCtx = useMemo(() => ({
        add,
        clear: clearAttachments,
        fileInputRef: inputRef,
        files: files.map((item) => ({ ...item, id: item.id })),
        openFileDialog,
        remove,
    }), [files, add, remove, clearAttachments, openFileDialog]);
    const refsCtx = useMemo(() => ({
        add: (incoming) => {
            const array = Array.isArray(incoming) ? incoming : [incoming];
            setReferencedSources((prev) => [
                ...prev,
                ...array.map((s) => ({ ...s, id: nanoid() })),
            ]);
        },
        clear: clearReferencedSources,
        remove: (id) => {
            setReferencedSources((prev) => prev.filter((s) => s.id !== id));
        },
        sources: referencedSources,
    }), [referencedSources, clearReferencedSources]);
    const handleSubmit = useCallback(async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const text = usingProvider
            ? controller.textInput.value
            : (() => {
                const formData = new FormData(form);
                return formData.get("message") || "";
            })();
        // Reset form immediately after capturing text to avoid race condition
        // where user input during async blob conversion would be lost
        if (!usingProvider) {
            form.reset();
        }
        try {
            // Convert blob URLs to data URLs asynchronously
            const convertedFiles = await Promise.all(files.map(async ({ id: _id, ...item }) => {
                if (item.url?.startsWith("blob:")) {
                    const dataUrl = await convertBlobUrlToDataUrl(item.url);
                    // If conversion failed, keep the original blob URL
                    return {
                        ...item,
                        url: dataUrl ?? item.url,
                    };
                }
                return item;
            }));
            const result = onSubmit({ files: convertedFiles, text }, event);
            // Handle both sync and async onSubmit
            if (result instanceof Promise) {
                try {
                    await result;
                    clear();
                    if (usingProvider) {
                        controller.textInput.clear();
                    }
                }
                catch {
                    // Don't clear on error - user may want to retry
                }
            }
            else {
                // Sync function completed without throwing, clear inputs
                clear();
                if (usingProvider) {
                    controller.textInput.clear();
                }
            }
        }
        catch {
            // Don't clear on error - user may want to retry
        }
    }, [usingProvider, controller, files, onSubmit, clear]);
    // Render with or without local provider
    const inner = (_jsxs(_Fragment, { children: [_jsx("input", { accept: accept, "aria-label": "Upload files", className: "hidden", multiple: multiple, onChange: handleChange, ref: inputRef, title: "Upload files", type: "file" }), _jsx("form", { className: cn("w-full", className), onSubmit: handleSubmit, ref: formRef, ...props, children: _jsx(InputGroup, { className: "overflow-hidden", children: children }) })] }));
    const withReferencedSources = (_jsx(LocalReferencedSourcesContext.Provider, { value: refsCtx, children: inner }));
    // Always provide LocalAttachmentsContext so children get validated add function
    return (_jsx(LocalAttachmentsContext.Provider, { value: attachmentsCtx, children: withReferencedSources }));
};
export const PromptInputBody = ({ className, ...props }) => (_jsx("div", { className: cn("contents", className), ...props }));
export const PromptInputTextarea = ({ onChange, onKeyDown, onPaste, className, placeholder = "What would you like to know?", ...props }) => {
    const controller = useOptionalPromptInputController();
    const attachments = usePromptInputAttachments();
    const [isComposing, setIsComposing] = useState(false);
    const handleKeyDown = useCallback((e) => {
        // Call the external onKeyDown handler first
        onKeyDown?.(e);
        // If the external handler prevented default, don't run internal logic
        if (e.defaultPrevented) {
            return;
        }
        if (shouldSubmitPromptOnEnter({
            key: e.key,
            keyCode: e.keyCode,
            shiftKey: e.shiftKey,
            isComposing: isComposing || e.nativeEvent.isComposing,
        })) {
            e.preventDefault();
            // Check if the submit button is disabled before submitting
            const { form } = e.currentTarget;
            const submitButton = form?.querySelector('button[type="submit"]');
            if (submitButton?.disabled) {
                return;
            }
            form?.requestSubmit();
        }
        // Remove last attachment when Backspace is pressed and textarea is empty
        if (e.key === "Backspace" &&
            e.currentTarget.value === "" &&
            attachments.files.length > 0) {
            e.preventDefault();
            const lastAttachment = attachments.files.at(-1);
            if (lastAttachment) {
                attachments.remove(lastAttachment.id);
            }
        }
    }, [onKeyDown, isComposing, attachments]);
    const handlePaste = useCallback((event) => {
        onPaste?.(event);
        if (event.defaultPrevented) {
            return;
        }
        const items = event.clipboardData?.items;
        if (!items) {
            return;
        }
        const files = [];
        for (const item of items) {
            if (item.kind === "file") {
                const file = item.getAsFile();
                if (file) {
                    files.push(file);
                }
            }
        }
        if (files.length > 0) {
            event.preventDefault();
            attachments.add(files);
        }
    }, [attachments, onPaste]);
    const handleCompositionEnd = useCallback(() => setIsComposing(false), []);
    const handleCompositionStart = useCallback(() => setIsComposing(true), []);
    const controlledProps = controller
        ? {
            onChange: (e) => {
                controller.textInput.setInput(e.currentTarget.value);
                onChange?.(e);
            },
            value: controller.textInput.value,
        }
        : {
            onChange,
        };
    return (_jsx(InputGroupTextarea, { className: cn("field-sizing-content max-h-48 min-h-16", className), name: "message", onCompositionEnd: handleCompositionEnd, onCompositionStart: handleCompositionStart, onKeyDown: handleKeyDown, onPaste: handlePaste, placeholder: placeholder, ...props, ...controlledProps }));
};
export const PromptInputHeader = ({ className, ...props }) => (_jsx(InputGroupAddon, { align: "block-end", className: cn("order-first flex-wrap gap-1", className), ...props }));
export const PromptInputFooter = ({ className, ...props }) => (_jsx(InputGroupAddon, { align: "block-end", className: cn("justify-between gap-1", className), ...props }));
export const PromptInputTools = ({ className, ...props }) => (_jsx("div", { className: cn("flex min-w-0 items-center gap-1", className), ...props }));
export const PromptInputButton = ({ variant = "ghost", className, size, tooltip, ...props }) => {
    const newSize = size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");
    const button = (_jsx(InputGroupButton, { className: cn(className), size: newSize, type: "button", variant: variant, ...props }));
    if (!tooltip) {
        return button;
    }
    const tooltipContent = typeof tooltip === "string" ? tooltip : tooltip.content;
    const shortcut = typeof tooltip === "string" ? undefined : tooltip.shortcut;
    const side = typeof tooltip === "string" ? "top" : (tooltip.side ?? "top");
    return (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { children: button }), _jsxs(TooltipContent, { side: side, children: [tooltipContent, shortcut && (_jsx("span", { className: "ml-2 text-muted-foreground", children: shortcut }))] })] }));
};
export const PromptInputActionMenu = (props) => (_jsx(DropdownMenu, { ...props }));
export const PromptInputActionMenuTrigger = ({ className, children, ...props }) => (_jsx(DropdownMenuTrigger, { render: _jsx(PromptInputButton, { className: className, ...props }), children: children ?? _jsx(PlusIcon, { className: "size-4" }) }));
export const PromptInputActionMenuContent = ({ className, ...props }) => (_jsx(DropdownMenuContent, { align: "start", className: cn(className), ...props }));
export const PromptInputActionMenuItem = ({ className, ...props }) => (_jsx(DropdownMenuItem, { className: cn(className), ...props }));
export const PromptInputSubmit = ({ className, variant = "default", size = "icon-sm", status, onStop, onClick, children, ...props }) => {
    const isGenerating = status === "submitted" || status === "streaming";
    let Icon = _jsx(CornerDownLeftIcon, { className: "size-4" });
    if (status === "submitted") {
        Icon = _jsx(Spinner, {});
    }
    else if (status === "streaming") {
        Icon = _jsx(SquareIcon, { className: "size-4" });
    }
    else if (status === "error") {
        Icon = _jsx(XIcon, { className: "size-4" });
    }
    const handleClick = useCallback((e) => {
        if (isGenerating && onStop) {
            e.preventDefault();
            onStop();
            return;
        }
        onClick?.(e);
    }, [isGenerating, onStop, onClick]);
    return (_jsx(InputGroupButton, { "aria-label": isGenerating ? "Stop" : "Submit", className: cn(className), onClick: handleClick, size: size, type: isGenerating && onStop ? "button" : "submit", variant: variant, ...props, children: children ?? Icon }));
};
export const PromptInputSelect = (props) => (_jsx(Select, { ...props }));
export const PromptInputSelectTrigger = ({ className, ...props }) => (_jsx(SelectTrigger, { className: cn("border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors", "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground", className), ...props }));
export const PromptInputSelectContent = ({ className, ...props }) => (_jsx(SelectContent, { className: cn(className), ...props }));
export const PromptInputSelectItem = ({ className, ...props }) => (_jsx(SelectItem, { className: cn(className), ...props }));
export const PromptInputSelectValue = ({ className, ...props }) => (_jsx(SelectValue, { className: cn(className), ...props }));
export const PromptInputHoverCard = ({ openDelay = 0, closeDelay = 0, ...props }) => (_jsx(HoverCard, { closeDelay: closeDelay, openDelay: openDelay, ...props }));
export const PromptInputHoverCardTrigger = (props) => _jsx(HoverCardTrigger, { ...props });
export const PromptInputHoverCardContent = ({ align = "start", ...props }) => (_jsx(HoverCardContent, { align: align, ...props }));
export const PromptInputTabsList = ({ className, ...props }) => _jsx("div", { className: cn(className), ...props });
export const PromptInputTab = ({ className, ...props }) => _jsx("div", { className: cn(className), ...props });
export const PromptInputTabLabel = ({ className, ...props }) => (
// Content provided via children in props
// oxlint-disable-next-line eslint-plugin-jsx-a11y(heading-has-content)
_jsx("h3", { className: cn("mb-2 px-3 font-medium text-muted-foreground text-xs", className), ...props }));
export const PromptInputTabBody = ({ className, ...props }) => (_jsx("div", { className: cn("space-y-1", className), ...props }));
export const PromptInputTabItem = ({ className, ...props }) => (_jsx("div", { className: cn("flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent", className), ...props }));
export const PromptInputCommand = ({ className, ...props }) => _jsx(Command, { className: cn(className), ...props });
export const PromptInputCommandInput = ({ className, ...props }) => (_jsx(CommandInput, { className: cn(className), ...props }));
export const PromptInputCommandList = ({ className, ...props }) => (_jsx(CommandList, { className: cn(className), ...props }));
export const PromptInputCommandEmpty = ({ className, ...props }) => (_jsx(CommandEmpty, { className: cn(className), ...props }));
export const PromptInputCommandGroup = ({ className, ...props }) => (_jsx(CommandGroup, { className: cn(className), ...props }));
export const PromptInputCommandItem = ({ className, ...props }) => (_jsx(CommandItem, { className: cn(className), ...props }));
export const PromptInputCommandSeparator = ({ className, ...props }) => (_jsx(CommandSeparator, { className: cn(className), ...props }));

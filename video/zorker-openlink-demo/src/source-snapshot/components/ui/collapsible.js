"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn } from "../../lib/utils.js";
function Collapsible({ ...props }) {
    return _jsx(CollapsiblePrimitive.Root, { "data-slot": "collapsible", ...props });
}
function CollapsibleTrigger({ ...props }) {
    return (_jsx(CollapsiblePrimitive.Trigger, { "data-slot": "collapsible-trigger", ...props }));
}
function CollapsibleContent({ className, keepMounted = true, ...props }) {
    return (_jsx(CollapsiblePrimitive.Panel, { className: cn("openlink-collapsible-content", className), "data-slot": "collapsible-content", keepMounted: keepMounted, ...props }));
}
export { Collapsible, CollapsibleTrigger, CollapsibleContent };

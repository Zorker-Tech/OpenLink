import { jsx as _jsx } from "react/jsx-runtime";
export function SkeletonBar({ width, opacity, height = 3, }) {
    return (_jsx("span", { "aria-hidden": "true", className: "zbd-rd-bar", style: { width, height, opacity } }));
}

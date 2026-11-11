import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { EMAIL } from '../data/copy';
export function LoginView({ emailChars, passwordChars, focus }) {
    const email = EMAIL.slice(0, emailChars);
    const password = '•'.repeat(passwordChars);
    return (_jsxs("div", { className: "zbd-rd-login", children: [_jsx("span", { "aria-hidden": "true", className: "zbd-rd-avatar" }), _jsxs("div", { className: "zbd-rd-fields", children: [_jsxs("div", { className: "zbd-rd-field", "data-zbd-target": "portal-email", "data-focus": focus === 'email' ? 'true' : undefined, children: [email || _jsx("span", { className: "zbd-rd-placeholder", children: "Email" }), focus === 'email' ? _jsx("span", { className: "zbd-rd-caret" }) : null] }), _jsxs("div", { className: "zbd-rd-field", "data-zbd-target": "portal-password", "data-focus": focus === 'password' ? 'true' : undefined, children: [password || _jsx("span", { className: "zbd-rd-placeholder", children: "Password" }), focus === 'password' ? _jsx("span", { className: "zbd-rd-caret" }) : null] })] }), _jsx("button", { className: "zbd-rd-submit", "data-zbd-target": "portal-submit", tabIndex: -1, type: "button", children: "Sign in" })] }));
}

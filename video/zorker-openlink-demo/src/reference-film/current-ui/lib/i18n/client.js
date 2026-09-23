'use client';
import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useMemo } from 'react';
import { SOURCE_LOCALE } from "./locales.js";
import { createTranslator } from "./messages.js";
const I18nContext = createContext(null);
const sourceOnlyTranslator = createTranslator({});
/**
 * Locale + catalog for the current request.
 *
 * The locale arrives from the server (preference cookie), so the first paint
 * and the hydrated client render agree on every string — no post-mount swap
 * and no hydration mismatch.
 */
export function I18nProvider({ children, locale, messages }) {
    const value = useMemo(() => ({
        locale,
        messages,
        t: createTranslator(messages),
    }), [locale, messages]);
    return _jsx(I18nContext.Provider, { value: value, children: children });
}
/**
 * Translator for client components.
 *
 * Falls back to a source-string translator so a component rendered outside the
 * provider (stories, isolated tests) still renders real copy.
 */
export function useT() {
    return useContext(I18nContext)?.t ?? sourceOnlyTranslator;
}
export function useLocale() {
    return useContext(I18nContext)?.locale ?? SOURCE_LOCALE;
}
export function useMessages() {
    return useContext(I18nContext)?.messages ?? {};
}

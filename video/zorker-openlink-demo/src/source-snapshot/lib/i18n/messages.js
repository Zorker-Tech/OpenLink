import { DEFAULT_LOCALE, isLocale, normalizeLocale } from "./locales.js";
export const LOCALE_COOKIE = 'openlink-locale';
/** One year: the cookie mirrors the persisted preference for SSR. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const catalogs = new Map();
const loading = new Map();
/** Unknown markup in a catalog entry must not break interpolation. */
function fill(template, values) {
    if (!values)
        return template;
    return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = values[key];
        return value === undefined || value === null ? match : String(value);
    });
}
export function translate(messages, source, values) {
    const template = (messages && messages[source]) || source;
    return fill(template, values);
}
/**
 * Loads a catalog once per process. Catalogs are imported dynamically so a
 * request only ever ships the active locale's strings to the browser.
 */
export async function loadMessages(locale) {
    // zh-CN is the source language for most copy, but the catalog still matters:
    // strings authored in English resolve to Chinese through it.
    const cached = catalogs.get(locale);
    if (cached)
        return cached;
    const pending = loading.get(locale);
    if (pending)
        return pending;
    const request = (async () => {
        try {
            const module = await import(`./messages/${locale}.json`);
            const messages = (module.default ?? module);
            catalogs.set(locale, messages);
            return messages;
        }
        catch {
            // A locale may be configured before its catalog lands. Fall back to the
            // source strings instead of failing the render.
            catalogs.set(locale, {});
            return {};
        }
        finally {
            loading.delete(locale);
        }
    })();
    loading.set(locale, request);
    return request;
}
export function readLocaleCookieValue(value) {
    const normalized = normalizeLocale(value);
    if (normalized)
        return normalized;
    return isLocale(value) ? value : DEFAULT_LOCALE;
}
export function createTranslator(messages) {
    return (source, values) => translate(messages, source, values);
}

/**
 * Supported product locales.
 *
 * `zh-CN` is the source language: every string in the app is authored in
 * Simplified Chinese, and the catalogs in `lib/i18n/messages` translate those
 * strings for the other locales. A locale without a catalog entry falls back to
 * the source string, so a partially translated locale never renders blank UI.
 */
export const LOCALES = [
    'zh-CN',
    'zh-TW',
    'en-US',
    'en-SG',
    'de-DE',
    'fr-FR',
    'ja-JP',
    'ko-KR',
    'ru-RU',
];
export const DEFAULT_LOCALE = 'zh-CN';
export const SOURCE_LOCALE = 'zh-CN';
/** Native labels for the language picker, always shown in their own language. */
export const LOCALE_LABELS = {
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    'en-US': 'English (US)',
    'en-SG': 'English (Singapore)',
    'de-DE': 'Deutsch',
    'fr-FR': 'Français',
    'ja-JP': '日本語',
    'ko-KR': '한국어',
    'ru-RU': 'Русский',
};
/** Region-qualified names used in settings copy. */
export const LOCALE_REGIONS = {
    'zh-CN': '简体中文 · 中国',
    'zh-TW': '繁體中文 · 台灣',
    'en-US': 'English · United States',
    'en-SG': 'English · Singapore',
    'de-DE': 'Deutsch · Deutschland',
    'fr-FR': 'Français · France',
    'ja-JP': '日本語 · 日本',
    'ko-KR': '한국어 · 대한민국',
    'ru-RU': 'Русский · Россия',
};
export function isLocale(value) {
    return typeof value === 'string' && LOCALES.includes(value);
}
/**
 * Accepts legacy and shorthand tags (`en`, `zh-Hans`, `zh-Hant`, `pt-BR`) and
 * resolves them to a supported locale, so stored preferences and browser
 * headers from older clients keep working.
 */
export function normalizeLocale(value) {
    if (typeof value !== 'string')
        return null;
    const tag = value.trim();
    if (!tag)
        return null;
    if (isLocale(tag))
        return tag;
    const lower = tag.toLowerCase().replace('_', '-');
    if (lower === 'en' || lower === 'en-us' || lower.startsWith('en-us'))
        return 'en-US';
    if (lower === 'en-sg' || lower.startsWith('en-sg'))
        return 'en-SG';
    if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans' || lower.startsWith('zh-hans'))
        return 'zh-CN';
    if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant' || lower.startsWith('zh-hant'))
        return 'zh-TW';
    const base = lower.split('-')[0];
    if (base === 'de')
        return 'de-DE';
    if (base === 'fr')
        return 'fr-FR';
    if (base === 'ja')
        return 'ja-JP';
    if (base === 'ko')
        return 'ko-KR';
    if (base === 'ru')
        return 'ru-RU';
    return null;
}
/** Matches the closest supported locale to an `Accept-Language` header. */
export function localeFromAcceptLanguage(header) {
    if (!header)
        return null;
    const entries = header
        .split(',')
        .map((entry) => {
        const [tag, ...params] = entry.trim().split(';');
        const quality = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
        return { tag: tag.trim(), quality: quality ? Number(quality.slice(2)) || 0 : 1 };
    })
        .filter((entry) => entry.tag && entry.quality > 0)
        .sort((left, right) => right.quality - left.quality);
    for (const entry of entries) {
        const locale = normalizeLocale(entry.tag);
        if (locale)
            return locale;
    }
    return null;
}

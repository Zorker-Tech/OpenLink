// Theme resolution: explicit prop → ancestor data-theme/.dark|.light
// class (watched live) → prefers-color-scheme (subscribed live).
// SSR-safe: everything runs in effects; the pre-mount fallback is dark.
import { useEffect, useState } from 'react';
function ancestorTheme(el) {
    let node = el;
    while (node) {
        const attr = node.getAttribute('data-theme');
        if (attr === 'dark')
            return true;
        if (attr === 'light')
            return false;
        if (node.classList.contains('dark'))
            return true;
        if (node.classList.contains('light'))
            return false;
        node = node.parentElement;
    }
    return null;
}
function systemDark() {
    return typeof matchMedia === 'undefined' || matchMedia('(prefers-color-scheme: dark)').matches;
}
/** Resolve the effective dark/light substrate for a mounted element. */
export function useResolvedDark(theme, hostRef) {
    const [dark, setDark] = useState(true);
    useEffect(() => {
        if (theme === 'dark') {
            setDark(true);
            return;
        }
        if (theme === 'light') {
            setDark(false);
            return;
        }
        const resolve = () => {
            const fromTree = ancestorTheme(hostRef.current);
            setDark(fromTree ?? systemDark());
        };
        resolve();
        // live OS/browser theme switches
        const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
        const onMq = () => resolve();
        mq?.addEventListener('change', onMq);
        // live app-level toggles: watch class/data-theme flips on ancestors
        let mo = null;
        if (typeof MutationObserver !== 'undefined' && hostRef.current) {
            mo = new MutationObserver(resolve);
            mo.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['class', 'data-theme'],
                subtree: true
            });
        }
        return () => {
            mq?.removeEventListener('change', onMq);
            mo?.disconnect();
        };
    }, [theme, hostRef]);
    return dark;
}
/** Live `prefers-reduced-motion` — reduced users get a static frame. */
export function useReducedMotion() {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        if (typeof matchMedia === 'undefined')
            return;
        const mq = matchMedia('(prefers-reduced-motion: reduce)');
        setReduced(mq.matches);
        const on = (e) => setReduced(e.matches);
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, []);
    return reduced;
}

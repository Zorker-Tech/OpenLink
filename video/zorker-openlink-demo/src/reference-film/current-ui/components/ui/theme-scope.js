'use client';
import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext } from 'react';
import { MotionConfig } from 'motion/react';
const OpenLinkThemeContext = createContext(undefined);
export function OpenLinkThemeProvider({ children, theme }) {
    return (_jsx(MotionConfig, { reducedMotion: "user", children: _jsx(OpenLinkThemeContext.Provider, { value: theme, children: children }) }));
}
export function useOpenLinkTheme(explicitTheme) {
    return explicitTheme ?? useContext(OpenLinkThemeContext);
}

'use client';
import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext } from 'react';
const OpenLinkThemeContext = createContext(undefined);
export function OpenLinkThemeProvider({ children, theme }) {
    return _jsx(OpenLinkThemeContext.Provider, { value: theme, children: children });
}
export function useOpenLinkTheme(explicitTheme) {
    return explicitTheme ?? useContext(OpenLinkThemeContext);
}

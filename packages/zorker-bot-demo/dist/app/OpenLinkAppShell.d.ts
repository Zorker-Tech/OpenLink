import type { ComponentProps, ReactNode } from 'react';
export type OpenLinkAppShellProps = ComponentProps<'div'> & {
    navigation?: ReactNode;
    overlay?: ReactNode;
};
export declare function OpenLinkAppShell({ children, navigation, overlay, ...props }: OpenLinkAppShellProps): import("react").JSX.Element;
export type OpenLinkNavigationRailProps = ComponentProps<'nav'> & {
    footer?: ReactNode;
};
export declare function OpenLinkNavigationRail({ children, footer, ...props }: OpenLinkNavigationRailProps): import("react").JSX.Element;
//# sourceMappingURL=OpenLinkAppShell.d.ts.map
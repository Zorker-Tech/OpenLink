import { addons } from "storybook/manager-api"
import { create } from "storybook/theming/create"

addons.setConfig({
  theme: create({
    base: "light",
    brandTitle: "OpenLink Component Library",
    brandUrl: "/?path=/story/start-here-component-inventory--catalog",
    brandImage: "/openlink/logos/zorker-dark.svg",
    brandTarget: "_self",
    colorPrimary: "#2563eb",
    colorSecondary: "#2563eb",
    appBg: "#f7f8fa",
    appContentBg: "#ffffff",
    appBorderColor: "#e4e7ec",
    appBorderRadius: 10,
    fontBase: 'Geist, "Helvetica Neue", sans-serif',
    fontCode: '"SFMono-Regular", Consolas, monospace',
    textColor: "#18181b",
    textMutedColor: "#667085",
    barBg: "#ffffff",
    barSelectedColor: "#2563eb",
    inputBg: "#ffffff",
    inputBorder: "#d0d5dd",
    inputTextColor: "#18181b",
  }),
})

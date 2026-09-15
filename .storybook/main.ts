import type { StorybookConfig } from "@storybook/nextjs-vite"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mergeConfig } from "vite"

const storybookDir = path.dirname(fileURLToPath(import.meta.url))

const config: StorybookConfig = {
  stories: [
    "../stories/**/*.mdx",
    "../stories/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "../components/**/*.stories.@(js|jsx|mjs|ts|tsx)",
  ],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-vitest",
    "@chromatic-com/storybook",
  ],
  framework: {
    name: "@storybook/nextjs-vite",
    options: {},
  },
  staticDirs: ["../public"],
  docs: {
    defaultName: "Documentation",
  },
  viteFinal: async (baseConfig) => mergeConfig(baseConfig, {
    optimizeDeps: { include: ['@base-ui/react/accordion', 'embla-carousel-react', 'shiki', '@rive-app/react-webgl2', '@xyflow/react', 'media-chrome/react', 'react-jsx-parser'] },
    resolve: {
      alias: {
        "thinking-orbs": path.resolve(storybookDir, "../components/thinking/src/index.ts"),
        "@/app/chat/actions": path.resolve(storybookDir, "mocks/chat-actions.ts"),
        "@/app/settings/skills/actions": path.resolve(storybookDir, "mocks/product-actions.ts"),
        "@/app/settings/actions": path.resolve(storybookDir, "mocks/product-actions.ts"),
        "@/app/app/project-actions": path.resolve(storybookDir, "mocks/product-actions.ts"),
        "@/app/app/organization-actions": path.resolve(storybookDir, "mocks/product-actions.ts"),
        "@/utils/supabase/client": path.resolve(storybookDir, "mocks/supabase-client.ts"),
      },
    },
  }),
}

export default config

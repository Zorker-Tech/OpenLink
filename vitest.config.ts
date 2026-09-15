import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

import { playwright } from '@vitest/browser-playwright';

const dirname =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browserProvider = existsSync(localChrome)
  ? playwright({ launchOptions: { executablePath: localChrome } })
  : playwright({});

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  plugins: [
    {
      name: 'openlink-browser-global',
      transformIndexHtml: {
        order: 'pre',
        handler: () => [
          {
            tag: 'script',
            children: 'globalThis.global = globalThis;',
            injectTo: 'head-prepend',
          },
        ],
      },
    },
  ],
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          // The plugin will run tests for the stories defined in your Storybook config
          // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
          storybookTest({ configDir: path.join(dirname, '.storybook') }),
        ],
        test: {
          name: 'storybook',
          // Stories may install scoped browser fetch/portal fixtures while
          // exercising runtime-backed UI. Keep the project deterministic and
          // avoid cross-story global state races.
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
          browser: {
            enabled: true,
            headless: true,
            provider: browserProvider,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

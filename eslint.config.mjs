import configNext from 'eslint-config-next'

// The root gate owns the Next.js application: app/, components/, lib/,
// scripts/, stories/, utils/, packages/ and the root config files. Vendored or
// independently toolchained subtrees keep their own lint setup and are not
// re-linted from here.
const ignored = [
  'node_modules/**',
  '.next/**',
  'out/**',
  'build/**',
  'storybook-static/**',
  'next-env.d.ts',
  'backend/**',
  'services/**',
  'video/**',
  'zorkerbase/**',
  'license/**',
  'public/**',
  'docs/**',
  'deploy/**',
  'desktop/**',
]

const config = [
  { ignores: ignored },
  ...configNext,
  {
    rules: {
      // OpenLink is an App Router application without a pages/ directory, so
      // this rule cannot resolve a target and only emits noise.
      '@next/next/no-html-link-for-pages': 'off',
      // react-hooks v7 ships the React Compiler rule family. The application
      // predates those rules; keep them visible as warnings while existing
      // components are migrated instead of failing the release gate.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/static-components': 'warn',
    },
  },
]

export default config

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { FlatCompat } from '@eslint/eslintrc'
import book000Config from '@book000/eslint-config'

// eslint-config-next only ships legacy eslintrc-style configs (no flat
// config export yet), so FlatCompat bridges `next/core-web-vitals` into
// this flat config.
const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
})

const config = [
  ...book000Config,
  ...compat.extends('next/core-web-vitals'),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['tsconfig.json'],
      },
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'generated/**', 'next-env.d.ts'],
  },
  {
    // postcss.config.js must stay CommonJS: postcss/autoprefixer's config
    // loader resolves this file synchronously and does not support ESM here.
    files: ['postcss.config.js'],
    rules: {
      'unicorn/prefer-module': 'off',
    },
  },
]

export default config

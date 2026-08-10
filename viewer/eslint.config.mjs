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

// @book000/eslint-config と eslint-config-next はどちらも import plugin を登録する。
// pnpm 11 の frozen install では同じバージョンでも別のpluginオブジェクトとして
// 解決される場合があり、ESLintが再定義として拒否するため、Next側の重複だけ除く。
const nextConfig = compat.extends('next/core-web-vitals').map((entry) => {
  if (entry.plugins?.import === undefined) return entry
  const plugins = Object.fromEntries(
    Object.entries(entry.plugins).filter(([name]) => name !== 'import'),
  )
  return { ...entry, plugins }
})

const config = [
  ...book000Config,
  ...nextConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['tsconfig.json'],
      },
    },
  },
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'generated/**',
      'next-env.d.ts',
      'vitest.config.mts.timestamp-*.mjs',
    ],
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

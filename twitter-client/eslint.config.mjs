import book000Config from '@book000/eslint-config'

export default [
  ...book000Config,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['tsconfig.eslint.json'],
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
]

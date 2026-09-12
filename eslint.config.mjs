// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      'training/**',
      'backtest/**',
      '**/next.config.js',
      '**/postcss.config.js',
      'ecosystem.config.cjs',
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: [
      'scripts/**/*.ts',
      'packages/db/seed.ts',
      'packages/db/seedStrategiesOnly.ts',
      'packages/db/scripts/**/*.ts',
      'packages/binance-executor/src/cli.ts',
      'packages/binance-executor/src/logger.ts',
    ],
    rules: { 'no-console': 'off' },
  },
)

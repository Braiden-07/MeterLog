import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.config.mjs',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: no `any` without a comment justifying it. Warn rather than
      // error so the justification is a conscious act, not a lint-silencing one.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Node scripts run outside the TypeScript projects and outside any browser:
    // `console` and `process` are globals here, not undefined identifiers. Listed
    // explicitly rather than pulling in the `globals` package for two names —
    // this repo is deliberately install-light (CLAUDE.md guardrails).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
      sourceType: 'module',
    },
  },
  {
    // Raw SQL in the database suites is composed from module-level constants,
    // never from user input; $queryRawUnsafe is the only Prisma API that accepts
    // catalog queries and DDL.
    files: ['apps/api/test/db/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);

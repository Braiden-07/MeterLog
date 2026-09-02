import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['app/**/*.spec.{ts,tsx}', 'components/**/*.spec.{ts,tsx}'],
    // Playwright owns e2e; Vitest must not try to run those files.
    exclude: ['e2e/**', 'node_modules/**'],
  },
});

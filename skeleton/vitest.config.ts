import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    // Playwright specs live in tests/ and must never run under Vitest.
    exclude: ['tests/**', 'node_modules/**', 'dist/**'],
    server: {
      deps: {
        // Let Vite transform app-utils: its React surfaces import their
        // stylesheets, and Node's own loader throws "Unknown file extension
        // .css" on an externalised dependency.
        inline: [/@criblio\/app-utils/],
      },
    },
  },
});

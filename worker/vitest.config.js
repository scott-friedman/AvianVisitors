import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests run in plain Node (no workerd): src/index.js only needs Response/
// Request/crypto/Intl, all present in Node ≥18. The one Workers-only import,
// @cloudflare/puppeteer, is aliased to a stub — no unit test may launch a
// browser (that's the metered /frame.png path; its render body goes untested
// by design, everything around it is covered with fakes).
export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/puppeteer': fileURLToPath(new URL('./test/stubs/puppeteer.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});

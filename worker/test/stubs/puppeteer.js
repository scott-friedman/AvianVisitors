// Stub for @cloudflare/puppeteer in unit tests (see vitest.config.js).
// Any test that reaches a real render is a test bug — fail loudly.
export default {
  launch: async () => {
    throw new Error('puppeteer stub: unit tests must not render frames');
  },
};

import { defineConfig } from 'vitest/config';

// selftest/shop is a sample project with planted bugs for Ares to review, not part of this suite.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });

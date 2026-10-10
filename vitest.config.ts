import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts','apps/**/*.test.ts','tests/unit/**/*.test.ts','vendor/**/*.test.ts'], exclude: ['**/*.integration.test.ts'], testTimeout: 20000 } });

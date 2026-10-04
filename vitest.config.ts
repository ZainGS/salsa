import { defineConfig } from 'vitest/config';

// Test-only config (vite.config.ts stays the library build config; it has no test settings or plugins to inherit).
// The suite runs ~330 files in parallel, and several heavy tests (full crowd / city / vehicle builds) take 2–5 s
// alone, so the 5 s default timed them out intermittently under full-suite load while they passed on their own.
// 20 s is generous for those and still catches a real hang. Never use wall-clock assertions inside tests.
export default defineConfig({
    test: {
        testTimeout: 20000,
        hookTimeout: 20000,
    },
});

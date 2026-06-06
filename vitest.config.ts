import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Native deps (better-sqlite3, transitively playwright-firefox) make per-file import
// expensive. Running one worker per core saturates the CPU during the cold import
// storm, so timers are delayed and async route tests trip their timeout. Leave ~40%
// of the cores idle as headroom so the event loop always gets scheduled in time.
const maxWorkers = Math.max(2, Math.floor(availableParallelism() * 0.6));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    // Headroom alone isn't enough on a cold cache or under coverage instrumentation;
    // a generous ceiling keeps scheduling jitter under load from masquerading as a failure.
    testTimeout: 20000,
    hookTimeout: 20000,
    maxWorkers,
    minWorkers: 1,
  },
});

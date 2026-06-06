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
    //
    // Measured 2026-08-05 (10 cores): idle 5/5 green, half the cores busy 3/3 green,
    // fully saturated 1 failure in 3 — always `Test timed out`, never a failed
    // assertion, and a different file each time. So: do not run this suite next to a
    // Docker build, and do not raise this number when it trips. A lone timeout under
    // load is not a result; re-run the file on its own. Raising it further (or adding
    // retries) would only hide a genuine hang, which is the one thing this must catch.
    testTimeout: 20000,
    hookTimeout: 20000,
    maxWorkers,
    minWorkers: 1,
  },
});

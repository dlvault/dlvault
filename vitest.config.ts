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

    coverage: {
      provider: 'v8',
      // Host code only. plugins-dist/ holds separately-built source plugins with
      // their own bundling; they are not shipped from here and their live
      // contract is checked by the source canary, not by unit tests.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types/**'],
      reporter: ['text-summary', 'json-summary'],

      // A RATCHET, not a target. These are the floors as of the coverage pass on
      // 2026-08-24, rounded down so a normal run can never trip them. The rule:
      // they may only ever go UP, and only after a run shows real headroom.
      //
      // Deliberately NOT set to an aspirational number. A gate above what the
      // suite honestly reaches invites padding — tests written to move the
      // percentage rather than to catch anything, which cost maintenance and
      // give false confidence. Every bug found during that pass came from
      // executing untested code or reading production logs, never from chasing
      // this number.
      thresholds: {
        lines: 81,
        statements: 78,
        functions: 81,
        branches: 68,
      },
    },
  },
});

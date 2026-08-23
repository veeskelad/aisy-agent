import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      // Several integration specs here spawn real processes and assert on the
      // order and timing of their lifecycle events. With one worker per core
      // they compete with every other file for the same cores, and a fence that
      // is supposed to be observed misses its window — a failure that says
      // nothing about the code under test. Leaving cores free keeps those
      // assertions measuring the runtime instead of the scheduler.
      forks: { minForks: 1, maxForks: 4 },
    },
  },
})

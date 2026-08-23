#!/usr/bin/env node
// Legacy onboarding entry (not a linked bin — the app's unified `aisy` owns the
// command). Kept runnable via `node dist/bin/aisy.js` for core-only use.
// All adapter wiring lives in runtime/onboarding-node.ts.

import { runCli } from '../cli/index.js'
import { makeNodeOnboardingOps, harnessVersion } from '../runtime/onboarding-node.js'

const exitCode = await runCli(process.argv.slice(2), {
  ops: makeNodeOnboardingOps(),
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  version: harnessVersion(),
})
process.exit(exitCode)

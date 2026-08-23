import { appendFileSync } from 'node:fs'
import { makeNodeDelegationRunLock } from '../src/delegation-persistence.ts'

const runRoot = process.env['AISY_DELEGATION_LOCK_FIXTURE_RUN_ROOT']
const trace = process.env['AISY_DELEGATION_LOCK_FIXTURE_TRACE']
if (runRoot === undefined || trace === undefined) process.exit(64)

const release = makeNodeDelegationRunLock(runRoot).acquire()
appendFileSync(trace, `ready ${process.pid}\n`, { mode: 0o600 })

const stop = (): void => {
  try { release() } catch { process.exit(65) }
  appendFileSync(trace, `released ${process.pid}\n`, { mode: 0o600 })
  process.exit(0)
}

process.once('SIGTERM', stop)
process.once('SIGINT', stop)
setInterval(() => {}, 1_000)

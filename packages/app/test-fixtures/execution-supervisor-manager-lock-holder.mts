import { makeNodeExecutionSupervisorStateStore } from '../src/supervisor-state.ts'

const root = process.env['AISY_SUPERVISOR_FIXTURE_STATE_ROOT']
if (typeof root !== 'string' || root === '') process.exit(91)

const lease = makeNodeExecutionSupervisorStateStore({ root }).acquireManagerLease()
if (!lease.isHeld() || typeof process.send !== 'function') process.exit(92)
process.send('locked')

process.on('SIGTERM', () => {
  try { lease.release() } catch { process.exit(93) }
  process.exit(0)
})

setInterval(() => undefined, 1_000)

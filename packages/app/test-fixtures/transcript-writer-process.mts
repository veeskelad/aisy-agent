import { appendFileSync } from 'node:fs'

import {
  acquireTranscriptWriterLease,
  TranscriptWriterLeaseError,
} from '../src/transcript-writer-lease.ts'

const root = process.env['AISY_TRANSCRIPT_FIXTURE_ROOT']
const tracePath = process.env['AISY_TRANSCRIPT_FIXTURE_TRACE']
const externalPath = process.env['AISY_TRANSCRIPT_FIXTURE_EXTERNAL']
const mode = process.env['AISY_TRANSCRIPT_FIXTURE_MODE'] ?? 'once'
if (root === undefined || root === '' || tracePath === undefined || tracePath === '' ||
  externalPath === undefined || externalPath === '') process.exit(97)

function trace(event: string): void {
  appendFileSync(tracePath!, `${Date.now()} ${event} ${process.pid}\n`, { mode: 0o600 })
}

try {
  const lease = acquireTranscriptWriterLease({ root })
  trace('acquired')
  // This is the fixture's provider/tool/Telegram boundary. It is deliberately
  // unreachable until the production lease implementation has granted the
  // single-writer authority.
  appendFileSync(externalPath, `${Date.now()} external ${process.pid}\n`, { mode: 0o600 })
  if (mode === 'hold') {
    const release = (): void => {
      try {
        lease.release()
        trace('released')
        process.exit(0)
      } catch (error) {
        const reason = error instanceof TranscriptWriterLeaseError ? error.reason : 'unknown'
        trace(`release-refused-${reason}`)
        process.exit(74)
      }
    }
    process.once('SIGINT', release)
    process.once('SIGTERM', release)
    setInterval(() => {
      try {
        lease.assertOwned()
      } catch (error) {
        const reason = error instanceof TranscriptWriterLeaseError ? error.reason : 'unknown'
        trace(`lost-${reason}`)
        process.exit(75)
      }
    }, 20)
    await new Promise(() => {})
  }
  lease.assertOwned()
  lease.release()
  trace('released')
} catch (error) {
  const reason = error instanceof TranscriptWriterLeaseError ? error.reason : 'unknown'
  trace(`refused-${reason}`)
  process.stderr.write(`transcript fixture refused: ${reason}\n`)
  process.exit(73)
}

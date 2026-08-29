import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')

function index(fragment: string): number {
  const found = production.indexOf(fragment)
  expect(found, `missing production fragment: ${fragment}`).toBeGreaterThanOrEqual(0)
  return found
}

describe('live Session deletion composition', () => {
  it('loads the external fence and repairs selection before the first static binding', () => {
    const journal = index('const sessionDeletionJournal = makeSessionDeletionJournal')
    const registry = index('const registryPair:')
    const selectionRepair = index('await repairSessionDeletionSelections({')
    const firstSelection = index('const activeProjectSelection = projectRegistry.ensureDefault')

    expect(journal).toBeLessThan(registry)
    expect(production.slice(registry, selectionRepair)).toContain(
      'sessionFence: sessionDeletionJournal',
    )
    expect(selectionRepair).toBeLessThan(firstSelection)
  })

  it('finishes local deletion recovery before provider construction and wires one live runtime', () => {
    const media = index('const mediaInbox = ((): SingletonTelegramAttachmentInbox | null =>')
    const restart = index('const runtimeRestart = makeRuntimeRestart({')
    const coordinator = index('const sessionDeletionCoordinator =')
    const repair = index('await sessionDeletionCoordinator.repair()')
    const nightlyCreate = index('const nightlySession = projectRegistry.createSession(')
    const provider = index('const primaryAdapter: ProviderAdapter =')
    const telegram = index('sessionControls: makeTelegramSessionControls({')

    expect(media).toBeLessThan(coordinator)
    expect(restart).toBeLessThan(coordinator)
    expect(coordinator).toBeLessThan(repair)
    expect(repair).toBeLessThan(provider)
    expect(repair).toBeLessThan(nightlyCreate)
    expect(telegram).toBeGreaterThan(repair)
    expect(production.match(/makeRuntimeRestart\(\{/gu)).toHaveLength(1)
    expect(production.slice(coordinator, repair)).toContain(
      'mediaInbox.maintenance.purgeSession(target.sessionId)',
    )
    expect(production.slice(coordinator, repair)).toContain(
      'forwardBatchStore.purgeSession({',
    )
    expect(production.slice(coordinator, repair)).toContain(
      "throw new Error('SESSION_PROVIDER_PURGE_UNSUPPORTED')",
    )
    expect(production.slice(repair, provider)).toContain(
      'record.operationHash === recoveredDeletionOperation',
    )
    expect(production.slice(repair, provider)).toContain(
      'await runtimeRestart.commitExit(intent)',
    )
    expect(production.slice(coordinator, provider).match(
      /assertExactSessionDeletionRestartIntent\(intent, reason\)/gu,
    )).toHaveLength(2)
    expect(production.slice(telegram, telegram + 700)).toContain(
      'deletion: sessionDeletionCoordinator',
    )
    expect(production.slice(telegram, telegram + 700)).toContain(
      'transcript: sessionTranscriptMaintenance',
    )
  })
})

import {
  liveFactsForNightly,
  makeMemoryValidators,
  type ConsolidationRunSnapshot,
  type MemoryFact,
} from '@aisy/core'

export interface NightlyLiveSnapshotSource {
  listLive(): Promise<MemoryFact[]>
}

/**
 * Captures facts and matching validator authority from one per-run read.
 * The runner calls this only after acquiring night.lock.
 */
export function makeNightlyLiveSnapshotLoader(
  source: NightlyLiveSnapshotSource,
): () => Promise<ConsolidationRunSnapshot> {
  return async () => {
    const memoryFacts = await source.listLive()
    const facts = liveFactsForNightly(memoryFacts)
    return {
      facts,
      validators: makeMemoryValidators({
        liveFactIds: new Set(facts.filter((fact) => fact.invalidAt === null).map((fact) => fact.id)),
      }),
    }
  }
}

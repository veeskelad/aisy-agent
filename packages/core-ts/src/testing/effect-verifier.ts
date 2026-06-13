export type EffectKind =
  | 'file-write'
  | 'file-delete'
  | 'db-insert'
  | 'db-update'
  | 'db-delete'
  | 'outbound-call'
  | 'tool-call'
  | 'approval-request'
  | 'staging-write'

export interface RecordedEffect {
  kind: EffectKind
  target: string
  payload?: unknown
}

export interface EffectVerifier {
  record(effect: RecordedEffect): void
  readonly effects: readonly RecordedEffect[]
  expectEffect(kind: EffectKind, target: string): RecordedEffect
  expectNoEffect(kind: EffectKind): void
  reset(): void
}

export function makeEffectVerifier(): EffectVerifier {
  const effects: RecordedEffect[] = []
  return {
    get effects() { return effects as readonly RecordedEffect[] },
    record(e: RecordedEffect): void {
      effects.push(e)
    },
    expectEffect(kind: EffectKind, target: string): RecordedEffect {
      const found = effects.find(e => e.kind === kind && e.target === target)
      if (found === undefined) {
        const have = effects.map(e => `${e.kind}:${e.target}`).join(', ')
        throw new Error(`Expected effect ${kind}:${target} — not found in [${have}]`)
      }
      return found
    },
    expectNoEffect(kind: EffectKind): void {
      const found = effects.find(e => e.kind === kind)
      if (found !== undefined) {
        throw new Error(`Expected no effect of kind '${kind}', but found target '${found.target}'`)
      }
    },
    reset(): void {
      effects.length = 0
    },
  }
}

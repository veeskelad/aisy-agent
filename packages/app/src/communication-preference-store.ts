import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export type CommunicationPreferenceFamily =
  | 'verbosity'
  | 'internal-detail'
  | 'tone'
  | 'memory-ack'

export type CommunicationPreferenceDescriptor =
  | 'concise'
  | 'balanced'
  | 'detailed'
  | 'hide-internals'
  | 'show-internals'
  | 'natural-russian'
  | 'neutral-russian'
  | 'second-person-memory-ack'

type PreferenceSource = 'explicit' | 'inferred'

interface Revision {
  revisionId: string
  descriptor: CommunicationPreferenceDescriptor
  source: PreferenceSource
  policyRevision: 'communication-preference-v1'
  createdAt: string
  evidenceHashes: string[]
  sessionIds: string[]
}

interface FamilyState {
  schemaVersion: 1
  scopeHash: string
  family: CommunicationPreferenceFamily
  activeRevisionId?: string
  previousRevisionId?: string
  revisions: Revision[]
  tombstonedRevisionIds: string[]
  inferredEvidence: Array<{
    descriptor: CommunicationPreferenceDescriptor
    sessionId: string
    evidenceHash: string
  }>
}

export interface CommunicationPreferencePersistence {
  load(family: CommunicationPreferenceFamily): unknown | null
  save(family: CommunicationPreferenceFamily, state: unknown): void
}

export interface CommunicationPreferenceStore {
  observeExplicit(input: { text: string; sessionId: string; evidenceId: string }): number
  observeInferred(input: {
    descriptor: CommunicationPreferenceDescriptor
    sessionId: string
    evidenceId: string
  }): boolean
  overlay(): string
  active(): ReadonlyArray<{
    family: CommunicationPreferenceFamily
    descriptor: CommunicationPreferenceDescriptor
    source: PreferenceSource
    revisionId: string
  }>
  rollback(family: CommunicationPreferenceFamily): boolean
  forget(family: CommunicationPreferenceFamily): boolean
  healthyFamilies(): Readonly<Record<CommunicationPreferenceFamily, boolean>>
}

const FAMILIES: readonly CommunicationPreferenceFamily[] = [
  'verbosity', 'internal-detail', 'tone', 'memory-ack',
]
const DESCRIPTOR_FAMILY: Readonly<Record<CommunicationPreferenceDescriptor, CommunicationPreferenceFamily>> = {
  concise: 'verbosity',
  balanced: 'verbosity',
  detailed: 'verbosity',
  'hide-internals': 'internal-detail',
  'show-internals': 'internal-detail',
  'natural-russian': 'tone',
  'neutral-russian': 'tone',
  'second-person-memory-ack': 'memory-ack',
}
const PROMPT: Readonly<Record<CommunicationPreferenceDescriptor, string>> = {
  concise: 'Отвечай кратко и по делу; подробности добавляй только когда они нужны для решения.',
  balanced: 'Держи среднюю подробность: сначала результат, затем только полезный контекст.',
  detailed: 'Давай развёрнутые объяснения с существенными деталями.',
  'hide-internals': 'Не показывай служебные id, этапы verification/recovery, тайминги и системные формулировки.',
  'show-internals': 'Показывай технические детали выполнения, когда они помогают проверить результат.',
  'natural-russian': 'Пиши живым естественным русским языком от первого лица и обращайся к собеседнику на «ты».',
  'neutral-russian': 'Пиши нейтральным деловым русским языком без фамильярности.',
  'second-person-memory-ack': 'Подтверждай память естественно: «Запомнил, что ты…», без служебной записи факта.',
}
const DESCRIPTORS = new Set<CommunicationPreferenceDescriptor>(
  Object.keys(DESCRIPTOR_FAMILY) as CommunicationPreferenceDescriptor[],
)
const HASH = /^[a-f0-9]{64}$/u

function scopeHash(scope: { botId: string; operatorId: string; profileId: string }): string {
  return createHash('sha256').update(JSON.stringify([
    'aisy-communication-preference-scope/v1',
    scope.botId,
    scope.operatorId,
    scope.profileId,
  ])).digest('hex')
}

function evidenceHash(evidenceId: string): string {
  return createHash('sha256')
    .update('aisy-communication-preference-evidence/v1\0')
    .update(evidenceId)
    .digest('hex')
}

function empty(family: CommunicationPreferenceFamily, expectedScopeHash: string): FamilyState {
  return {
    schemaVersion: 1,
    scopeHash: expectedScopeHash,
    family,
    revisions: [],
    tombstonedRevisionIds: [],
    inferredEvidence: [],
  }
}

function decode(
  value: unknown,
  family: CommunicationPreferenceFamily,
  expectedScopeHash: string,
): FamilyState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const state = value as Partial<FamilyState>
  if (state.schemaVersion !== 1 || state.scopeHash !== expectedScopeHash || state.family !== family ||
    !Array.isArray(state.revisions) || !Array.isArray(state.tombstonedRevisionIds) ||
    !Array.isArray(state.inferredEvidence)) return null
  const revisions = state.revisions.filter((item): item is Revision =>
    typeof item === 'object' && item !== null && HASH.test(item.revisionId) &&
    DESCRIPTORS.has(item.descriptor) && DESCRIPTOR_FAMILY[item.descriptor] === family &&
    (item.source === 'explicit' || item.source === 'inferred') &&
    item.policyRevision === 'communication-preference-v1' &&
    typeof item.createdAt === 'string' && Array.isArray(item.evidenceHashes) &&
    item.evidenceHashes.every(hash => HASH.test(hash)) && Array.isArray(item.sessionIds) &&
    item.sessionIds.every(id => typeof id === 'string' && id.length > 0))
  if (revisions.length !== state.revisions.length) return null
  const ids = new Set(revisions.map(item => item.revisionId))
  if ((state.activeRevisionId !== undefined && !ids.has(state.activeRevisionId)) ||
    (state.previousRevisionId !== undefined && !ids.has(state.previousRevisionId)) ||
    !state.tombstonedRevisionIds.every(id => typeof id === 'string' && ids.has(id))) return null
  const inferredEvidence = state.inferredEvidence.filter(item =>
    typeof item === 'object' && item !== null && DESCRIPTORS.has(item.descriptor) &&
    DESCRIPTOR_FAMILY[item.descriptor] === family && typeof item.sessionId === 'string' &&
    item.sessionId.length > 0 && HASH.test(item.evidenceHash))
  if (inferredEvidence.length !== state.inferredEvidence.length) return null
  return structuredClone(state as FamilyState)
}

function explicitDescriptors(text: string): CommunicationPreferenceDescriptor[] {
  const normalized = text.trim().toLocaleLowerCase('ru-RU')
  const out = new Set<CommunicationPreferenceDescriptor>()
  if (/(?:говори|пиши|отвечай)\s+(?:покороче|короче|кратко)|без\s+лишн(?:его|ей)/u.test(normalized)) {
    out.add('concise')
  }
  if (/(?:говори|пиши|отвечай)\s+(?:подробнее|подробно|разв[её]рнуто)/u.test(normalized)) {
    out.add('detailed')
  }
  if (/не\s+(?:надо|нужно|стоит)?\s*(?:показывать|показывай|писать|пиши|говорить|говори).*(?:служеб|verification|recovery|тайминг|системн|delegationid|айди|\bid\b)/u.test(normalized)) {
    out.add('hide-internals')
  }
  if (/(?:слишком|чересчур|через\s+чур|перебор).*(?:провер|контрол)|не\s+переборщ.*(?:провер|контрол)/u.test(normalized)) {
    out.add('hide-internals')
  }
  if (/(?:пиши|говори|отвечай).*(?:живее|естественн|человечн)|не\s+живой\s+диалог/u.test(normalized)) {
    out.add('natural-russian')
  }
  if (/запомнил,?\s+что\s+ты|пиши.*запомнил.*что\s+ты/u.test(normalized)) {
    out.add('second-person-memory-ack')
  }
  return [...out]
}

export function makeCommunicationPreferenceStore(input: {
  scope: { botId: string; operatorId: string; profileId: string }
  persistence: CommunicationPreferencePersistence
  nowIso?: () => string
}): CommunicationPreferenceStore {
  const expectedScopeHash = scopeHash(input.scope)
  const healthy = Object.fromEntries(FAMILIES.map(family => [family, true])) as
    Record<CommunicationPreferenceFamily, boolean>
  const states = new Map<CommunicationPreferenceFamily, FamilyState>()
  for (const family of FAMILIES) {
    const loaded = input.persistence.load(family)
    if (loaded === null) states.set(family, empty(family, expectedScopeHash))
    else {
      const parsed = decode(loaded, family, expectedScopeHash)
      if (parsed === null) {
        healthy[family] = false
        states.set(family, empty(family, expectedScopeHash))
      } else states.set(family, parsed)
    }
  }
  const nowIso = input.nowIso ?? (() => new Date().toISOString())

  const activate = (
    descriptor: CommunicationPreferenceDescriptor,
    source: PreferenceSource,
    sessionIds: string[],
    evidenceHashes: string[],
  ): boolean => {
    const family = DESCRIPTOR_FAMILY[descriptor]
    if (!healthy[family]) return false
    const current = states.get(family)!
    const active = current.revisions.find(item => item.revisionId === current.activeRevisionId)
    if (active?.descriptor === descriptor && active.source === source) return false
    const createdAt = nowIso()
    const revisionId = createHash('sha256').update(JSON.stringify([
      'aisy-communication-preference-revision/v1', expectedScopeHash, family,
      descriptor, source, createdAt, evidenceHashes,
    ])).digest('hex')
    const revision: Revision = {
      revisionId,
      descriptor,
      source,
      policyRevision: 'communication-preference-v1',
      createdAt,
      evidenceHashes: [...evidenceHashes],
      sessionIds: [...sessionIds],
    }
    const next: FamilyState = {
      ...current,
      activeRevisionId: revisionId,
      ...(current.activeRevisionId === undefined
        ? {}
        : { previousRevisionId: current.activeRevisionId }),
      revisions: [...current.revisions, revision],
    }
    input.persistence.save(family, next)
    states.set(family, next)
    return true
  }

  return Object.freeze<CommunicationPreferenceStore>({
    observeExplicit(observation) {
      const descriptors = explicitDescriptors(observation.text)
      let changed = 0
      for (const descriptor of descriptors) {
        if (activate(
          descriptor,
          'explicit',
          [observation.sessionId],
          [evidenceHash(observation.evidenceId)],
        )) changed++
      }
      return changed
    },

    observeInferred(observation) {
      const family = DESCRIPTOR_FAMILY[observation.descriptor]
      if (!healthy[family]) return false
      const current = states.get(family)!
      const hash = evidenceHash(observation.evidenceId)
      const evidence = current.inferredEvidence.some(item =>
        item.descriptor === observation.descriptor && item.sessionId === observation.sessionId)
        ? current.inferredEvidence
        : [...current.inferredEvidence, {
            descriptor: observation.descriptor,
            sessionId: observation.sessionId,
            evidenceHash: hash,
          }].slice(-40)
      const sessions = [...new Set(evidence
        .filter(item => item.descriptor === observation.descriptor)
        .map(item => item.sessionId))]
      if (sessions.length < 2) {
        const next = { ...current, inferredEvidence: evidence }
        input.persistence.save(family, next)
        states.set(family, next)
        return false
      }
      return activate(
        observation.descriptor,
        'inferred',
        sessions,
        evidence.filter(item => item.descriptor === observation.descriptor)
          .map(item => item.evidenceHash),
      )
    },

    overlay() {
      const lines = FAMILIES.flatMap(family => {
        if (!healthy[family]) return []
        const state = states.get(family)!
        const active = state.revisions.find(item => item.revisionId === state.activeRevisionId)
        return active === undefined ? [] : [PROMPT[active.descriptor]]
      })
      return lines.join('\n')
    },

    active() {
      return FAMILIES.flatMap(family => {
        if (!healthy[family]) return []
        const state = states.get(family)!
        const revision = state.revisions.find(item => item.revisionId === state.activeRevisionId)
        return revision === undefined ? [] : [{
          family,
          descriptor: revision.descriptor,
          source: revision.source,
          revisionId: revision.revisionId,
        }]
      })
    },

    rollback(family) {
      if (!healthy[family]) return false
      const current = states.get(family)!
      if (current.previousRevisionId === undefined || current.activeRevisionId === undefined) return false
      const next: FamilyState = {
        ...current,
        activeRevisionId: current.previousRevisionId,
        previousRevisionId: current.activeRevisionId,
      }
      input.persistence.save(family, next)
      states.set(family, next)
      return true
    },

    forget(family) {
      if (!healthy[family]) return false
      const current = states.get(family)!
      if (current.activeRevisionId === undefined) return false
      const next: FamilyState = {
        ...current,
        tombstonedRevisionIds: [...new Set([
          ...current.tombstonedRevisionIds,
          current.activeRevisionId,
        ])],
      }
      delete next.activeRevisionId
      delete next.previousRevisionId
      input.persistence.save(family, next)
      states.set(family, next)
      return true
    },

    healthyFamilies: () => ({ ...healthy }),
  })
}

function sync(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeCommunicationPreferencePersistence(
  directory: string,
): CommunicationPreferencePersistence {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return {
    load(family) {
      const path = join(directory, `${family}.json`)
      if (!existsSync(path)) return null
      try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { return { corrupt: true } }
    },
    save(family, state) {
      const path = join(directory, `${family}.json`)
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      sync(temporary)
      renameSync(temporary, path)
      sync(directory)
    },
  }
}

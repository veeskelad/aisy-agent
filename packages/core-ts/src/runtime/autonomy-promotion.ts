// Обучаемая автономность, срез 2: промоушен (ADR-0061, спека 24 §5). LIVE с
// ADR-0103.
//
// Дозревший кандидат становится грантом только через карточку тира 3 — расши-
// рение полномочий принадлежит тому же классу операций, что деньги и постоянная
// память (ADR-0029). Второй фактор на этой карточке опционален (ADR-0104):
// подтверждает её тап оператора, а код — там, где установка его проверяет. Здесь живёт арифметика этого перехода: канонический
// конверт действия, одноразовый proof, TTL и отзыв. Чего здесь нет — так это
// enforcement: сам факт «этот вызов покрыт выученным грантом» будет проверять
// HookGate в срезе активации, и до него ни один вызов не минует карточку.
//
// Proof-протокол намеренно зеркалит agent-card lifecycle (ADR-0069): один
// формат доказательств для всех операций, расширяющих полномочия, дешевле в
// аудите, чем три похожих.

import { createHash } from 'node:crypto'

import type { ApprovalProof } from '../gateway/types.js'

// ---------------------------------------------------------------------------
// Нормативные константы (спека 24 §5)
// ---------------------------------------------------------------------------

/** Автономия не бессрочна: дольше этого грант не живёт, продление — карточкой. */
export const LEARNED_GRANT_TTL_DAYS_MAX = 90

const DAY_MS = 86_400_000
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

// ---------------------------------------------------------------------------
// Конверт действия и proof
// ---------------------------------------------------------------------------

export interface LearnedGrantEnvelope {
  workflowKey: string
  scope: { projectId: string; tool: string; resourcePattern: string }
  tier: 1 | 2
  /** Монотонная версия гранта этого процесса: 1, 2, … */
  version: number
  issuedAt: string
  expiresAt: string
}

function envelopeTuple(e: LearnedGrantEnvelope): unknown[] {
  return [
    e.workflowKey,
    e.scope.projectId, e.scope.tool, e.scope.resourcePattern,
    e.tier, e.version, e.issuedAt, e.expiresAt,
  ]
}

/** Канонический id и хэш карточки промоушена — то, что подпишет оператор. */
export function learnedGrantAction(
  envelope: LearnedGrantEnvelope,
): Readonly<{ actionId: string; actionHash: string }> {
  const actionId = `autonomy:promote:${envelope.workflowKey}:${envelope.version}`
  const actionHash = createHash('sha256').update(JSON.stringify([
    'aisy.autonomy.promote.v1', ...envelopeTuple(envelope),
  ])).digest('hex')
  return Object.freeze({ actionId, actionHash })
}

function validProof(value: unknown): ApprovalProof | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (typeof raw['cardId'] !== 'string' || raw['cardId'].trim() === '' ||
    typeof raw['actionId'] !== 'string' || typeof raw['actionHash'] !== 'string' ||
    typeof raw['confirmedAt'] !== 'string' || !ISO_INSTANT.test(raw['confirmedAt']) ||
    raw['stepUpVerified'] !== true) return null
  return {
    cardId: raw['cardId'],
    actionId: raw['actionId'],
    actionHash: raw['actionHash'],
    confirmedAt: raw['confirmedAt'],
    stepUpVerified: true,
  }
}

// ---------------------------------------------------------------------------
// Гранты
// ---------------------------------------------------------------------------

export interface LearnedGrant extends LearnedGrantEnvelope {
  approvedBy: string
  proofCardId: string
  /** Прежняя версия, которую этот грант сменил, или null для первой. */
  rollbackRef: number | null
  revoked?: { at: string; why: string }
}

export interface LearnedGrantStateV1 {
  schemaVersion: 1
  grants: LearnedGrant[]
  /** Использованные карточки: повтор того же proof не создаёт второй грант. */
  usedProofCards: string[]
}

export interface LearnedGrantPersistence {
  load(): unknown
  save(state: LearnedGrantStateV1): void
}

export type PromoteRefusal =
  | 'proof-invalid' | 'proof-mismatch' | 'proof-reused'
  | 'ttl-exceeded' | 'version-gap' | 'store-corrupt'

export interface LearnedGrantRegistry {
  /** Оформляет грант по подтверждённой карточке. Вне карточки не существует. */
  promote(input: {
    envelope: LearnedGrantEnvelope
    approvedBy: string
    proof: unknown
  }): { granted: LearnedGrant } | { refused: PromoteRefusal }
  /** Живой грант процесса: не отозван и не истёк. */
  active(workflowKey: string, nowIso: string): LearnedGrant | null
  /** Отзыв — сужение полномочий, поэтому всегда успешен и идемпотентен. */
  revoke(workflowKey: string, why: string): void
  /** Для экрана «Гранты»: все версии, включая отозванные. */
  list(): readonly LearnedGrant[]
  corrupted(): boolean
}

function parseState(raw: unknown): LearnedGrantStateV1 | null {
  if (typeof raw !== 'object' || raw === null) return null
  const state = raw as Record<string, unknown>
  if (state['schemaVersion'] !== 1 || !Array.isArray(state['grants']) ||
    !Array.isArray(state['usedProofCards'])) return null
  return raw as LearnedGrantStateV1
}

export function makeLearnedGrantRegistry(deps: {
  persistence: LearnedGrantPersistence
  nowIso: () => string
}): LearnedGrantRegistry {
  let state: LearnedGrantStateV1 = { schemaVersion: 1, grants: [], usedProofCards: [] }
  let corrupt = false
  try {
    const raw = deps.persistence.load()
    if (raw !== undefined && raw !== null) {
      const parsed = parseState(raw)
      // Повреждённое состояние грантов — fail-closed в обе стороны: новые не
      // выдаются, а active() молчит, то есть всё снова идёт через карточки.
      // Это единственная безопасная деградация для полномочий.
      if (parsed === null) corrupt = true
      else state = parsed
    }
  } catch {
    corrupt = true
  }

  const persist = (): void => { deps.persistence.save(state) }

  const lastVersion = (key: string): number =>
    state.grants.filter((g) => g.workflowKey === key)
      .reduce((max, g) => Math.max(max, g.version), 0)

  return {
    corrupted: () => corrupt,

    promote: ({ envelope, approvedBy, proof }) => {
      if (corrupt) return { refused: 'store-corrupt' }
      const validated = validProof(proof)
      if (validated === null || typeof approvedBy !== 'string' || approvedBy.trim() === '') {
        return { refused: 'proof-invalid' }
      }
      const expected = learnedGrantAction(envelope)
      // Proof привязан к точному хэшу конверта: карточка, подтверждённая для
      // одного процесса, не оформляет грант другому (AC-24-5).
      if (validated.actionId !== expected.actionId ||
        validated.actionHash !== expected.actionHash) {
        return { refused: 'proof-mismatch' }
      }
      if (state.usedProofCards.includes(validated.cardId)) {
        return { refused: 'proof-reused' }
      }
      const issued = Date.parse(envelope.issuedAt)
      const expires = Date.parse(envelope.expiresAt)
      if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued ||
        expires - issued > LEARNED_GRANT_TTL_DAYS_MAX * DAY_MS) {
        return { refused: 'ttl-exceeded' }
      }
      const prior = lastVersion(envelope.workflowKey)
      if (envelope.version !== prior + 1) return { refused: 'version-gap' }

      // Новый грант сменяет прежний: две живые версии одного процесса — это
      // два ответа на вопрос «что разрешено», а ответ должен быть один.
      const now = deps.nowIso()
      for (const grant of state.grants) {
        if (grant.workflowKey === envelope.workflowKey && grant.revoked === undefined) {
          grant.revoked = { at: now, why: 'superseded' }
        }
      }
      const granted: LearnedGrant = {
        ...envelope,
        approvedBy,
        proofCardId: validated.cardId,
        rollbackRef: prior === 0 ? null : prior,
      }
      state.grants.push(granted)
      state.usedProofCards.push(validated.cardId)
      persist()
      return { granted }
    },

    active: (workflowKey, nowIso) => {
      if (corrupt) return null
      const now = Date.parse(nowIso)
      if (!Number.isFinite(now)) return null
      return state.grants.find((g) =>
        g.workflowKey === workflowKey && g.revoked === undefined &&
        now >= Date.parse(g.issuedAt) && now < Date.parse(g.expiresAt)) ?? null
    },

    revoke: (workflowKey, why) => {
      if (corrupt) return
      let changed = false
      const now = deps.nowIso()
      for (const grant of state.grants) {
        if (grant.workflowKey === workflowKey && grant.revoked === undefined) {
          grant.revoked = { at: now, why }
          changed = true
        }
      }
      if (changed) persist()
    },

    list: () => [...state.grants],
  }
}

// ---------------------------------------------------------------------------
// Каскад: доказательство рухнуло — грант падает следом
// ---------------------------------------------------------------------------

/**
 * Порт `learnedAutonomy` для HookGate: покрыт ли этот конкретный вызов живым
 * грантом.
 *
 * Scope сверяется точно (AC-24-6). Проект берётся из durable binding хода, а не
 * из аргументов вызова: аргументы приходят от модели, а привязка — от runtime,
 * и полномочие обязано опираться на второе. Ресурс сверяется по той же
 * нормализации, что строила ключ, — процесс «читать docs.example.com» не
 * покрывает «читать другой домен», даже если инструмент тот же.
 */
export function makeLearnedAutonomyPort(deps: {
  grants: Pick<LearnedGrantRegistry, 'active'>
  /** Ключ процесса для этого вызова, или null — вызов не входит ни в один. */
  keyFor: (call: { name: string; args: Record<string, unknown> }) => string | null
  /** Точный ресурс вызова для сверки со scope гранта. */
  resourceFor: (call: { name: string; args: Record<string, unknown> }) => string | null
  projectId: () => string
  nowIso: () => string
}): (call: { name: string; args: Record<string, unknown> }) => boolean {
  return (call) => {
    const key = deps.keyFor(call)
    if (key === null) return false
    const grant = deps.grants.active(key, deps.nowIso())
    if (grant === null) return false
    if (grant.scope.projectId !== deps.projectId()) return false
    if (grant.scope.tool !== call.name) return false
    const resource = deps.resourceFor(call)
    return resource !== null && resource === grant.scope.resourcePattern
  }
}

/** Почему автономия сузилась. Причина попадает и в журнал, и в строку оператору. */
export type DemotionReason =
  | 'operator-correction' | 'failed-postcondition' | 'evidence-forgotten' | 'operator-revoke'

const DEMOTION_LINE: Readonly<Record<DemotionReason, string>> = Object.freeze({
  'operator-correction': 'Ты поправил меня в этом процессе — снова спрашиваю подтверждение.',
  'failed-postcondition': 'Проверка результата не прошла — снова спрашиваю подтверждение.',
  'evidence-forgotten': 'Доказательства удалены вместе с проектом — автономия снята.',
  'operator-revoke': 'Автономия отозвана.',
})

/**
 * Каскад забывания: удалили проект или сессию — автономия, стоявшая на этих
 * доказательствах, уходит вместе с ними (AC-24-10).
 *
 * Порядок тот же и по той же причине: **сначала гранты, потом записи**. Если
 * процесс упадёт между шагами, останется лишний журнал — неприятно, но
 * безопасно; обратный порядок оставил бы действующее разрешение, доказательств
 * которого уже нет.
 *
 * Гранты отзываются по проекту целиком: у гранта есть `scope.projectId`, и
 * сверять его с забытым проектом достаточно — процесс, чьи демонстрации жили в
 * другом проекте, не затрагивается.
 */
export function forgetLearnedAutonomy(input: {
  selector: { projectId?: string; sessionId?: string }
  grants: Pick<LearnedGrantRegistry, 'list' | 'revoke'>
  evidence: { forget: (selector: { projectId?: string; sessionId?: string }) => { removed: number } }
  emit?: (event: string, payload: Record<string, unknown>) => void
}): { revoked: number; removed: number } {
  const { projectId } = input.selector
  let revoked = 0
  if (projectId !== undefined) {
    for (const grant of input.grants.list()) {
      if (grant.revoked === undefined && grant.scope.projectId === projectId) {
        input.grants.revoke(grant.workflowKey, 'evidence-forgotten')
        revoked += 1
      }
    }
  }
  const { removed } = input.evidence.forget(input.selector)
  if (revoked > 0 || removed > 0) {
    input.emit?.('autonomy.forgotten', { ...input.selector, revoked, removed })
  }
  return { revoked, removed }
}

/**
 * Один вход для сужения автономии: гасит грант и сжигает накопленный счёт.
 *
 * Порядок нормативен (спека 24 §7): **сначала отзыв гранта, потом демоушен
 * доказательств**. Осиротевший грант опаснее осиротевшей записи — если процесс
 * упадёт между шагами, лучше потерять счётчик, чем оставить действующим
 * разрешение, доказательства которого уже недействительны.
 */
export function demoteLearnedAutonomy(input: {
  workflowKey: string
  reason: DemotionReason
  grants: Pick<LearnedGrantRegistry, 'revoke'>
  evidence: { demote: (key: string, why: string) => void }
  emit?: (event: string, payload: Record<string, unknown>) => void
}): { line: string } {
  input.grants.revoke(input.workflowKey, input.reason)
  input.evidence.demote(input.workflowKey, input.reason)
  input.emit?.('autonomy.demoted', {
    workflowKey: input.workflowKey,
    reason: input.reason,
  })
  return { line: DEMOTION_LINE[input.reason] }
}

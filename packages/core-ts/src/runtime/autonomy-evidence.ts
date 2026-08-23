// Обучаемая автономность, срез 1: доказательства и их арифметика (ADR-0061,
// спека 24). LIVE с ADR-0103: production composition создаёт этот журнал.
//
// Ядро отвечает на один вопрос: «дозрел ли этот рабочий процесс до предложения
// автономии?» — и отвечает на него кодом. Модель может предложить кандидата
// словами; изменить счётчики, пороги или состояние она не может, потому что
// у неё нет инструмента, который сюда пишет. Записи порождает runtime после
// завершённого хода, и только с operator-provenance: спан из письма или
// страницы демонстрацией не является.
//
// Промоушен (выдача гранта по step-up карточке) сюда не входит — это следующий
// срез, завязанный на gateway proof. Здесь: наблюдение, зрелость, shadow-счёт,
// демоушен и каскадное забывание.

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Пороги (нормативные значения v1 — спека 24 §5). Ужесточать можно, ослаблять
// нельзя: конструктор отвергает конфигурацию мягче нормативной.
// ---------------------------------------------------------------------------

export interface AutonomyThresholds {
  /** Подтверждённых демонстраций для кандидата. */
  minConfirmed: number
  /** Различных сессий среди подтверждённых. */
  minDistinctSessions: number
  /** Календарное окно между первой и последней, в днях. */
  minWindowDays: number
  /** Shadow-совпадений подряд (последние N все совпали). */
  minShadowMatches: number
}

export const NORMATIVE_THRESHOLDS: AutonomyThresholds = Object.freeze({
  minConfirmed: 5,
  minDistinctSessions: 3,
  minWindowDays: 7,
  minShadowMatches: 3,
})

// ---------------------------------------------------------------------------
// Записи журнала. Append-only JSONL; исправление — новая запись, не правка.
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  tool: string
  /** Класс аргументов, не сами аргументы: «путь в проекте», «https-ссылка». */
  argClass: string
  /** Ресурсная маска: точный домен, каталог, репозиторий. */
  resourceMask: string
}

/**
 * Детерминированный ключ рабочего процесса. Свободного текста внутри нет:
 * два процесса либо совпадают по ключу, либо это разные процессы.
 */
export function workflowKey(steps: readonly WorkflowStep[]): string {
  const canonical = steps.map((s) => [s.tool, s.argClass, s.resourceMask])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)
}

export type DemonstrationOutcome =
  | 'confirmed' | 'corrected' | 'rejected' | 'failed-postcondition'

export interface DemonstrationInput {
  workflowKey: string
  scope: { projectId: string; tool: string; resourcePattern: string }
  /** Tier 3 непредставим: такой процесс не наблюдается вовсе. */
  tier: 1 | 2
  binding: { operatorId: string; projectId: string; sessionId: string }
  evidence: { transcriptRef: string; traceRef?: string }
  outcome: DemonstrationOutcome
  /** Только operator: запись с другим provenance отвергается. */
  provenance: 'operator'
}

type LedgerEntry =
  | ({ kind: 'demonstration'; at: string } & DemonstrationInput)
  | { kind: 'shadow'; workflowKey: string; projectId: string; matched: boolean; at: string }
  | { kind: 'demote'; workflowKey: string; why: string; at: string }

export interface AutonomyCandidate {
  workflowKey: string
  scope: { projectId: string; tool: string; resourcePattern: string }
  tier: 1 | 2
  stats: {
    confirmed: number
    distinctSessions: number
    corrected: number
    windowDays: number
    shadowStreak: number
  }
  /** Дозрел по всем порогам — можно показывать карточку промоушена. */
  ripe: boolean
}

// ---------------------------------------------------------------------------
// Порты. Персистентность — строки наружу, строки внутрь; ядро не знает про fs.
// ---------------------------------------------------------------------------

export interface EvidencePersistence {
  /** Все строки журнала. Бросок означает недоступный store. */
  load(): readonly string[]
  append(line: string): void
  /** Полная перезапись — единственный путь физического забывания. */
  rewrite(lines: readonly string[]): void
}

export interface AutonomyLedgerDeps {
  persistence: EvidencePersistence
  nowIso: () => string
  thresholds?: Partial<AutonomyThresholds>
  /** Журнал событий (Observability); отсутствие — не ошибка. */
  emit?: (event: string, payload: Record<string, unknown>) => void
}

export type ObserveResult = 'recorded' | 'refused-provenance' | 'refused-tier' | 'refused-corrupt'

export interface AutonomyLedger {
  observe(input: DemonstrationInput): ObserveResult
  /** Итог shadow-сверки: предсказал ли код ровно то, что подтвердил оператор. */
  shadowResult(input: { workflowKey: string; projectId: string; matched: boolean }): void
  /** Кандидаты, дозревшие до карточки. Повреждённый store ⇒ пусто. */
  ripeCandidates(): readonly AutonomyCandidate[]
  /** Все наблюдаемые кандидаты — для экрана и тестов. */
  candidates(): readonly AutonomyCandidate[]
  /** Демоушен: одно исправление или проваленная проба — и зрелость сгорела. */
  demote(key: string, why: string): void
  /** Физически удаляет записи проекта/сессии. Идемпотентно. */
  forget(selector: { projectId?: string; sessionId?: string }): { removed: number }
  /** Store повреждён: наблюдение отключено, кандидатов нет, гранты не трогаем. */
  corrupted(): boolean
}

const DAY_MS = 86_400_000

function parseEntry(line: string): LedgerEntry | null {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return null }
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  if (kind !== 'demonstration' && kind !== 'shadow' && kind !== 'demote') return null
  return raw as LedgerEntry
}

export function makeAutonomyLedger(deps: AutonomyLedgerDeps): AutonomyLedger {
  const t: AutonomyThresholds = {
    minConfirmed: Math.max(NORMATIVE_THRESHOLDS.minConfirmed, deps.thresholds?.minConfirmed ?? 0),
    minDistinctSessions: Math.max(
      NORMATIVE_THRESHOLDS.minDistinctSessions, deps.thresholds?.minDistinctSessions ?? 0),
    minWindowDays: Math.max(
      NORMATIVE_THRESHOLDS.minWindowDays, deps.thresholds?.minWindowDays ?? 0),
    minShadowMatches: Math.max(
      NORMATIVE_THRESHOLDS.minShadowMatches, deps.thresholds?.minShadowMatches ?? 0),
  }

  // Проекция в памяти, пересобираемая из JSONL при каждом создании. Авторитет —
  // файл; проекция — ускорение. Одна битая строка гасит весь вывод: кандидаты,
  // выращенные на частично прочитанном журнале, хуже отсутствия кандидатов.
  let entries: LedgerEntry[] = []
  let corrupt = false
  try {
    const lines = deps.persistence.load()
    for (const line of lines) {
      if (line.trim().length === 0) continue
      const entry = parseEntry(line)
      if (entry === null) { corrupt = true; entries = []; break }
      entries.push(entry)
    }
  } catch {
    corrupt = true
  }
  if (corrupt) deps.emit?.('autonomy.store_corrupt', {})

  const persist = (entry: LedgerEntry): void => {
    deps.persistence.append(JSON.stringify(entry))
    entries.push(entry)
  }

  const candidateFor = (key: string): AutonomyCandidate | null => {
    const demos = entries.filter(
      (e): e is Extract<LedgerEntry, { kind: 'demonstration' }> =>
        e.kind === 'demonstration' && e.workflowKey === key)
    if (demos.length === 0) return null
    const last = demos[demos.length - 1]!

    // Демоушен сжигает всё до себя: и демонстрации, и shadow-счёт. Доверие
    // набирается заново, а не продолжает старый счёт с того же места.
    const lastDemote = [...entries].reverse().find(
      (e) => e.kind === 'demote' && e.workflowKey === key)
    const since = lastDemote?.at ?? ''
    const live = demos.filter((d) => d.at > since)

    const confirmed = live.filter((d) => d.outcome === 'confirmed')
    const corrected = live.filter((d) => d.outcome !== 'confirmed')
    const sessions = new Set(confirmed.map((d) => d.binding.sessionId))
    const times = confirmed.map((d) => Date.parse(d.at)).filter((n) => Number.isFinite(n))
    const windowDays = times.length < 2
      ? 0
      : (Math.max(...times) - Math.min(...times)) / DAY_MS

    // Последние 5 записей процесса: любое не-подтверждение среди них — свежая
    // рана, и зрелость обнуляется до тех пор, пока хвост не станет чистым.
    const tail = live.slice(-5)
    const tailClean = tail.every((d) => d.outcome === 'confirmed')

    const shadows = entries.filter(
      (e): e is Extract<LedgerEntry, { kind: 'shadow' }> =>
        e.kind === 'shadow' && e.workflowKey === key && e.at > since)
    let streak = 0
    for (let i = shadows.length - 1; i >= 0; i -= 1) {
      if (!shadows[i]!.matched) break
      streak += 1
    }

    const ripe = confirmed.length >= t.minConfirmed &&
      sessions.size >= t.minDistinctSessions &&
      windowDays >= t.minWindowDays &&
      tailClean &&
      streak >= t.minShadowMatches

    return {
      workflowKey: key,
      scope: last.scope,
      tier: last.tier,
      stats: {
        confirmed: confirmed.length,
        distinctSessions: sessions.size,
        corrected: corrected.length,
        windowDays: Math.floor(windowDays * 10) / 10,
        shadowStreak: streak,
      },
      ripe,
    }
  }

  const allCandidates = (): AutonomyCandidate[] => {
    if (corrupt) return []
    const keys = [...new Set(entries
      .filter((e) => e.kind === 'demonstration')
      .map((e) => e.workflowKey))]
    return keys
      .map(candidateFor)
      .filter((c): c is AutonomyCandidate => c !== null)
  }

  return {
    corrupted: () => corrupt,

    observe: (input) => {
      // Provenance — это граница, а не поле анкеты: запись, которую пытаются
      // создать из untrusted-хода, отвергается до касания диска (AC-24-1).
      if (input.provenance !== 'operator') return 'refused-provenance'
      // Классификацию тира владеет Safety; здесь — последний рубеж типа.
      if (input.tier !== 1 && input.tier !== 2) return 'refused-tier'
      if (corrupt) return 'refused-corrupt'
      persist({ kind: 'demonstration', at: deps.nowIso(), ...input })
      return 'recorded'
    },

    shadowResult: (input) => {
      if (corrupt) return
      persist({
        kind: 'shadow',
        workflowKey: input.workflowKey,
        projectId: input.projectId,
        matched: input.matched,
        at: deps.nowIso(),
      })
    },

    candidates: allCandidates,

    ripeCandidates: () => allCandidates().filter((c) => c.ripe),

    demote: (key, why) => {
      if (corrupt) return
      persist({ kind: 'demote', workflowKey: key, why, at: deps.nowIso() })
      deps.emit?.('autonomy.demoted', { workflowKey: key, why })
    },

    forget: (selector) => {
      if (selector.projectId === undefined && selector.sessionId === undefined) {
        return { removed: 0 }
      }
      const keep = entries.filter((e) => {
        if (e.kind === 'demote') return true
        if (e.kind === 'shadow') {
          return selector.projectId === undefined || e.projectId !== selector.projectId
        }
        if (selector.projectId !== undefined && e.binding.projectId === selector.projectId) {
          return false
        }
        return !(selector.sessionId !== undefined && e.binding.sessionId === selector.sessionId)
      })
      const removed = entries.length - keep.length
      if (removed > 0) {
        // Забывание — единственная операция, которой позволено переписать
        // журнал: приватность сильнее append-only (спека 24 §5).
        deps.persistence.rewrite(keep.map((e) => JSON.stringify(e)))
        entries = keep
        deps.emit?.('autonomy.forgotten', { removed, ...selector })
      }
      return { removed }
    },
  }
}

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ResolvedWorkBinding } from '@aisy/core'

const HASH = /^[a-f0-9]{64}$/u
const MAX_BYTES = 4 * 1024 * 1024

export interface SessionDependantTarget {
  operatorId: string
  profileId: string
  projectId: string
  sessionId: string
}

interface SessionDependantReceiptV1 extends SessionDependantTarget {
  operationHash: string
  settledAt: string
  goalChanged: boolean
  triggerIds: string[]
  backgroundBindings: string[]
  terminalDelegationRunIds: string[]
}

interface SessionDependantStateV1 {
  schemaVersion: 1
  records: SessionDependantReceiptV1[]
}

export interface NodeSessionDependants {
  assertIdle(target: SessionDependantTarget): void
  settle(target: SessionDependantTarget, operationHash: string): void
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactBinding(value: unknown, target: SessionDependantTarget): boolean {
  const binding = record(value)
  return binding?.['operatorId'] === target.operatorId &&
    binding['profileId'] === target.profileId &&
    binding['projectId'] === target.projectId &&
    binding['sessionId'] === target.sessionId
}

function sameBinding(binding: Readonly<ResolvedWorkBinding>, target: SessionDependantTarget): boolean {
  return binding.operatorId === target.operatorId && binding.profileId === target.profileId &&
    binding.projectId === target.projectId && binding.sessionId === target.sessionId
}

function readBounded(path: string): string {
  const bytes = readFileSync(path)
  if (bytes.byteLength > MAX_BYTES) throw new Error('SESSION_DEPENDANTS_STATE_CORRUPT')
  return bytes.toString('utf8')
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function cleanupAtomicTemps(path: string): void {
  const directory = dirname(path)
  if (!existsSync(directory)) return
  const prefix = `${basename(path)}.tmp-`
  let removed = false
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue
    if (!/^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      name.slice(prefix.length),
    )) throw new Error('SESSION_DEPENDANTS_STATE_CORRUPT')
    const temporary = join(directory, name)
    const info = lstatSync(temporary)
    const owner = typeof process.getuid === 'function' ? process.getuid() : info.uid
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== owner ||
      (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) {
      throw new Error('SESSION_DEPENDANTS_STATE_CORRUPT')
    }
    unlinkSync(temporary)
    removed = true
  }
  if (removed) syncPath(directory)
}

function saveAtomic(path: string, value: unknown): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  cleanupAtomicTemps(path)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  })
  syncPath(temporary)
  renameSync(temporary, path)
  syncPath(directory)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
}

function loadState(path: string): SessionDependantStateV1 {
  if (!existsSync(path)) return { schemaVersion: 1, records: [] }
  let value: unknown
  try { value = JSON.parse(readBounded(path)) as unknown } catch {
    throw new Error('SESSION_DEPENDANTS_STATE_CORRUPT')
  }
  const state = record(value)
  if (state?.['schemaVersion'] !== 1 || !Array.isArray(state['records']) ||
    Object.keys(state).some((key) => !['schemaVersion', 'records'].includes(key))) {
    throw new Error('SESSION_DEPENDANTS_STATE_CORRUPT')
  }
  const operations = new Set<string>()
  const records = state['records'].map((item): SessionDependantReceiptV1 => {
    const raw = record(item)
    const operationHash = raw?.['operationHash']
    if (raw === null || typeof operationHash !== 'string' || !HASH.test(operationHash) ||
      operations.has(operationHash) || !validIso(raw['settledAt']) ||
      typeof raw['operatorId'] !== 'string' || typeof raw['profileId'] !== 'string' ||
      typeof raw['projectId'] !== 'string' || typeof raw['sessionId'] !== 'string' ||
      typeof raw['goalChanged'] !== 'boolean' || !Array.isArray(raw['triggerIds']) ||
      raw['triggerIds'].some((id) => typeof id !== 'string') ||
      !Array.isArray(raw['backgroundBindings']) ||
      raw['backgroundBindings'].some((id) => typeof id !== 'string') ||
      (raw['terminalDelegationRunIds'] !== undefined &&
        (!Array.isArray(raw['terminalDelegationRunIds']) ||
          raw['terminalDelegationRunIds'].some((id) => typeof id !== 'string'))) ||
      Object.keys(raw).some((key) => ![
        'operationHash', 'operatorId', 'profileId', 'projectId', 'sessionId',
        'settledAt', 'goalChanged', 'triggerIds', 'backgroundBindings',
        'terminalDelegationRunIds',
      ].includes(key))) {
      throw new Error('SESSION_DEPENDANTS_STATE_CORRUPT')
    }
    operations.add(operationHash)
    return {
      operationHash,
      operatorId: raw['operatorId'],
      profileId: raw['profileId'],
      projectId: raw['projectId'],
      sessionId: raw['sessionId'],
      settledAt: raw['settledAt'],
      goalChanged: raw['goalChanged'],
      triggerIds: [...raw['triggerIds']] as string[],
      backgroundBindings: [...raw['backgroundBindings']] as string[],
      terminalDelegationRunIds: raw['terminalDelegationRunIds'] === undefined
        ? []
        : [...raw['terminalDelegationRunIds']] as string[],
    }
  })
  return { schemaVersion: 1, records }
}

export function makeNodeSessionDependants(input: {
  statePath: string
  goalPath: string
  triggersPath: string
  nowIso: () => string
  liveTurns: (target: SessionDependantTarget) => number
  continuationBindings: () => readonly Readonly<ResolvedWorkBinding>[]
  delegationBindings: () => readonly Readonly<ResolvedWorkBinding>[]
  disableBackgroundBindings?: (target: SessionDependantTarget) => string[]
  purgeTerminalDelegations?: (target: SessionDependantTarget) => readonly string[]
}): NodeSessionDependants {
  cleanupAtomicTemps(input.statePath)
  let state = loadState(input.statePath)
  return Object.freeze<NodeSessionDependants>({
    assertIdle(target) {
      if (input.liveTurns(target) > 0 ||
        input.continuationBindings().some((binding) => sameBinding(binding, target)) ||
        input.delegationBindings().some((binding) => sameBinding(binding, target))) {
        throw new Error('SESSION_BUSY')
      }
    },
    settle(target, operationHash) {
      if (!HASH.test(operationHash)) throw new Error('SESSION_DEPENDANTS_AUTHORITY_INVALID')
      const existing = state.records.find((item) => item.operationHash === operationHash)
      if (existing !== undefined) {
        if (!exactBinding(existing, target)) throw new Error('SESSION_DEPENDANTS_IDENTITY_CONFLICT')
        return
      }

      let goalChanged = false
      if (existsSync(input.goalPath)) {
        let goal: unknown
        try { goal = JSON.parse(readBounded(input.goalPath)) as unknown } catch {
          throw new Error('SESSION_DEPENDANTS_GOAL_CORRUPT')
        }
        const raw = record(goal)
        if (raw !== null && raw['status'] === 'active' && exactBinding(raw['binding'], target)) {
          saveAtomic(input.goalPath, {
            ...raw,
            status: 'halted',
            haltReason: 'context-deleted',
            updatedAt: input.nowIso(),
          })
          goalChanged = true
        }
      }

      const triggerIds: string[] = []
      if (existsSync(input.triggersPath)) {
        let triggers: unknown
        try { triggers = JSON.parse(readBounded(input.triggersPath)) as unknown } catch {
          throw new Error('SESSION_DEPENDANTS_TRIGGERS_CORRUPT')
        }
        if (!Array.isArray(triggers)) throw new Error('SESSION_DEPENDANTS_TRIGGERS_CORRUPT')
        let triggersChanged = false
        const settled = triggers.map((item) => {
          const raw = record(item)
          if (raw === null || !exactBinding(raw['binding'], target)) {
            return item
          }
          if (typeof raw['id'] === 'string') triggerIds.push(raw['id'])
          if (raw['enabled'] !== true) return item
          triggersChanged = true
          return { ...raw, enabled: false }
        })
        if (triggersChanged) saveAtomic(input.triggersPath, settled)
      }

      const receipt: SessionDependantReceiptV1 = {
        operationHash,
        ...target,
        settledAt: input.nowIso(),
        goalChanged,
        triggerIds,
        backgroundBindings: input.disableBackgroundBindings?.(target) ?? [],
        terminalDelegationRunIds: [
          ...(input.purgeTerminalDelegations?.(target) ?? []),
        ],
      }
      state = { schemaVersion: 1, records: [...state.records, receipt] }
      saveAtomic(input.statePath, state)
    },
  })
}

import {
  resolvedWorkBinding,
  type ResolvedWorkBinding,
} from '@aisy/core'
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
import { dirname } from 'node:path'

export interface NightlyMaintenanceBindings {
  workspace: ResolvedWorkBinding
  projects: ResolvedWorkBinding[]
}

export type NightlyMaintenanceBindingLoadResult =
  | { status: 'missing' }
  | { status: 'ready'; bindings: NightlyMaintenanceBindings }
  | { status: 'quarantined'; reason: 'invalid-maintenance-bindings' }

export interface NightlyMaintenanceBindingStore {
  load(): NightlyMaintenanceBindingLoadResult
  save(bindings: NightlyMaintenanceBindings): void
}

interface StoreState {
  schemaVersion: 1
  workspace: ResolvedWorkBinding
  projects: ResolvedWorkBinding[]
}

const MAX_BYTES = 1024 * 1024
const MAX_PROJECTS = 256
const STATE_KEYS = new Set(['schemaVersion', 'workspace', 'projects'])
const BINDING_KEYS = new Set(['operatorId', 'profileId', 'projectId', 'sessionId', 'scope'])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every((key) => keys.has(key))
}

function exactBinding(value: unknown): ResolvedWorkBinding {
  if (!record(value) || !exactKeys(value, BINDING_KEYS)) throw new Error('invalid binding')
  return resolvedWorkBinding(value)
}

export function validateNightlyMaintenanceBindings(value: unknown): NightlyMaintenanceBindings {
  if (!record(value)) throw new Error('invalid maintenance bindings')
  const candidate = 'schemaVersion' in value
    ? value
    : { schemaVersion: 1, ...value }
  if (!record(candidate) || !exactKeys(candidate, STATE_KEYS) || candidate['schemaVersion'] !== 1 ||
    !Array.isArray(candidate['projects']) || candidate['projects'].length > MAX_PROJECTS) {
    throw new Error('invalid maintenance bindings')
  }
  const workspace = exactBinding(candidate['workspace'])
  if (workspace.scope !== 'workspace') throw new Error('invalid workspace binding')
  const projects = candidate['projects'].map(exactBinding)
  const seenProjects = new Set<string>()
  const seenSessions = new Set<string>()
  for (const binding of projects) {
    if (binding.scope !== 'project' || binding.operatorId !== workspace.operatorId ||
      binding.profileId !== workspace.profileId || binding.projectId === workspace.projectId ||
      seenProjects.has(binding.projectId) || seenSessions.has(binding.sessionId)) {
      throw new Error('invalid project maintenance binding')
    }
    seenProjects.add(binding.projectId)
    seenSessions.add(binding.sessionId)
  }
  projects.sort((left, right) =>
    left.projectId.localeCompare(right.projectId) || left.sessionId.localeCompare(right.sessionId))
  return {
    workspace: Object.freeze({ ...workspace }),
    projects: projects.map((binding) => Object.freeze({ ...binding })),
  }
}

export function makeNightlyMaintenanceBindingStore(input: {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
  saveAtomic(content: string): void
}): NightlyMaintenanceBindingStore {
  return {
    load() {
      if (!input.exists(input.path)) return { status: 'missing' }
      try {
        const content = input.readFile(input.path)
        if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('too large')
        return {
          status: 'ready',
          bindings: validateNightlyMaintenanceBindings(JSON.parse(content) as unknown),
        }
      } catch {
        return { status: 'quarantined', reason: 'invalid-maintenance-bindings' }
      }
    },

    save(bindings) {
      const validated = validateNightlyMaintenanceBindings(bindings)
      const content = JSON.stringify({ schemaVersion: 1, ...validated }, null, 2) + '\n'
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('maintenance bindings too large')
      input.saveAtomic(content)
    },
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeNightlyMaintenanceBindingStore(input: {
  path: string
}): NightlyMaintenanceBindingStore {
  const directory = dirname(input.path)
  const tempPath = input.path + '.tmp'
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return makeNightlyMaintenanceBindingStore({
    path: input.path,
    exists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    saveAtomic: (content) => {
      writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(tempPath)
      renameSync(tempPath, input.path)
      syncPath(directory)
    },
  })
}

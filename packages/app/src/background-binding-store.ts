import {
  resolvedWorkBinding,
  type ResolvedWorkBinding,
} from '@aisy/core'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export type BackgroundBindingName = 'nightly'

export type BackgroundBindingLoadResult =
  | { status: 'missing' }
  | { status: 'ready'; binding: ResolvedWorkBinding }
  | { status: 'quarantined'; reason: 'missing-or-invalid-work-binding' | 'context-deleted' }

export interface BackgroundBindingStore {
  load(name: BackgroundBindingName): BackgroundBindingLoadResult
  save(name: BackgroundBindingName, binding: ResolvedWorkBinding): void
  disableExactSession(binding: Pick<ResolvedWorkBinding,
  'operatorId' | 'profileId' | 'projectId' | 'sessionId'>): BackgroundBindingName[]
}

export interface BackgroundBindingStoreDeps {
  path: string
  readFile: (path: string) => string
  saveAtomic: (content: string) => void
  exists: (path: string) => boolean
}

interface StoreState {
  schemaVersion: 1
  bindings: Partial<Record<BackgroundBindingName, ResolvedWorkBinding>>
  quarantine?: Partial<Record<
  BackgroundBindingName,
  'missing-or-invalid-work-binding' | 'context-deleted'
  >>
  quarantinedBindings?: Partial<Record<BackgroundBindingName, unknown>>
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

export function makeBackgroundBindingStore(
  deps: BackgroundBindingStoreDeps,
): BackgroundBindingStore {
  const empty = (): StoreState => ({ schemaVersion: 1, bindings: {} })

  const read = (): StoreState => {
    if (!deps.exists(deps.path)) return empty()
    try {
      const parsed = record(JSON.parse(deps.readFile(deps.path)) as unknown)
      if (!parsed || parsed['schemaVersion'] !== 1 || !record(parsed['bindings'])) {
        return {
          ...empty(),
          quarantine: { nightly: 'missing-or-invalid-work-binding' },
        }
      }
      return parsed as unknown as StoreState
    } catch {
      return {
        ...empty(),
        quarantine: { nightly: 'missing-or-invalid-work-binding' },
      }
    }
  }

  const write = (state: StoreState): void => {
    deps.saveAtomic(JSON.stringify(state, null, 2) + '\n')
  }

  return {
    load(name) {
      const state = read()
      if (state.quarantine?.[name]) return { status: 'quarantined', reason: state.quarantine[name] }
      const candidate = state.bindings[name]
      if (candidate === undefined) return { status: 'missing' }
      try {
        return { status: 'ready', binding: resolvedWorkBinding(candidate) }
      } catch {
        state.quarantinedBindings = {
          ...state.quarantinedBindings,
          [name]: candidate,
        }
        delete state.bindings[name]
        state.quarantine = {
          ...state.quarantine,
          [name]: 'missing-or-invalid-work-binding',
        }
        write(state)
        return { status: 'quarantined', reason: 'missing-or-invalid-work-binding' }
      }
    },

    save(name, binding) {
      const validated = resolvedWorkBinding(binding)
      const state = read()
      state.bindings[name] = validated
      if (state.quarantine) delete state.quarantine[name]
      write(state)
    },

    disableExactSession(binding) {
      const state = read()
      const disabled: BackgroundBindingName[] = []
      for (const name of ['nightly'] as const) {
        const candidate = state.bindings[name]
        if (candidate === undefined || candidate.operatorId !== binding.operatorId ||
          candidate.profileId !== binding.profileId || candidate.projectId !== binding.projectId ||
          candidate.sessionId !== binding.sessionId) continue
        state.quarantinedBindings = { ...state.quarantinedBindings, [name]: candidate }
        delete state.bindings[name]
        state.quarantine = { ...state.quarantine, [name]: 'context-deleted' }
        disabled.push(name)
      }
      if (disabled.length > 0) write(state)
      return disabled
    },
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function makeNodeBackgroundBindingStore(input: {
  path: string
}): BackgroundBindingStore {
  const directory = dirname(input.path)
  const tempPath = input.path + '.tmp'
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (existsSync(tempPath)) {
    const info = lstatSync(tempPath)
    const owner = typeof process.getuid === 'function' ? process.getuid() : info.uid
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== owner ||
      (info.mode & 0o077) !== 0) throw new Error('BACKGROUND_BINDING_STORE_UNSAFE')
    // rename is the commit point; this fixed-path file can only be residue from
    // the previous, already-dead singleton writer during bootstrap.
    unlinkSync(tempPath)
    syncPath(directory)
  }
  return makeBackgroundBindingStore({
    path: input.path,
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, 'utf8'),
    saveAtomic: (content) => {
      writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(tempPath)
      renameSync(tempPath, input.path)
      syncPath(directory)
    },
  })
}

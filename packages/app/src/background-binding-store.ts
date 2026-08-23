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

export type BackgroundBindingName = 'nightly'

export type BackgroundBindingLoadResult =
  | { status: 'missing' }
  | { status: 'ready'; binding: ResolvedWorkBinding }
  | { status: 'quarantined'; reason: 'missing-or-invalid-work-binding' }

export interface BackgroundBindingStore {
  load(name: BackgroundBindingName): BackgroundBindingLoadResult
  save(name: BackgroundBindingName, binding: ResolvedWorkBinding): void
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
  quarantine?: Partial<Record<BackgroundBindingName, 'missing-or-invalid-work-binding'>>
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

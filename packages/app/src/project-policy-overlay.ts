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
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  normalize as normalizeFsPath,
  posix,
  relative,
  sep,
} from 'node:path'

import type {
  ResolvedWorkspacePath,
  RuntimePolicyNarrowing,
  ToolEffect,
  WorkspaceResourceSeal,
} from '@aisy/core'

export const PROJECT_POLICY_MODES = [
  'ask-before-delete',
  'confirm-writes',
  'read-only',
  'no-egress',
] as const

export type ProjectPolicyMode = (typeof PROJECT_POLICY_MODES)[number]

export interface ProjectPolicyOverlayV1 {
  projectId: string
  /** null means the whole Project; otherwise a normalized Project-relative directory. */
  relativePath: string | null
  modes: ProjectPolicyMode[]
}

export interface ProjectPolicyStateV1 {
  schemaVersion: 1
  revision: number
  overlays: ProjectPolicyOverlayV1[]
}

export interface ProjectPolicyOverlayStore {
  revision(): number
  snapshot(): ProjectPolicyStateV1
  tighten(input: Readonly<{
    projectId: string
    relativePath: string | null
    mode: ProjectPolicyMode
    expectedRevision: number
  }>): 'tightened' | 'already-strict' | 'stale'
  relax(input: Readonly<{
    projectId: string
    relativePath: string | null
    mode: ProjectPolicyMode
    expectedRevision: number
  }>): 'relaxed' | 'already-absent' | 'stale'
  evaluate(input: Readonly<{
    projectId: string
    tool: string
    args: Readonly<Record<string, unknown>>
    effect: ToolEffect | null
    outboundSink: boolean
    relativePath: string | null
  }>): RuntimePolicyNarrowing
}

export class ProjectPolicyOverlayError extends Error {
  constructor(public readonly code: 'CORRUPT_PROJECT_POLICY_STORE' | 'INSECURE_PROJECT_POLICY_STORE') {
    super(code)
    this.name = 'ProjectPolicyOverlayError'
  }
}

const SAFE_ID = /^[^\p{Cc}\p{Cf}]{1,256}$/u
const MAX_BYTES = 1024 * 1024
const MAX_OVERLAYS = 1_000

export function isProjectPolicyMode(value: unknown): value is ProjectPolicyMode {
  return typeof value === 'string' && (PROJECT_POLICY_MODES as readonly string[]).includes(value)
}

export function normalizeProjectPolicyRelativePath(value: string): string | null {
  const input = value.normalize('NFKC')
  if (input.includes('\0') || /[\p{Cc}\p{Cf}]/u.test(input) || input.startsWith('/')) return null
  const normalized = posix.normalize(input.length === 0 ? '.' : input)
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) return null
  return normalized
}

/**
 * Canonical resource identity shared by policy matching and live file I/O.
 * Missing final files are allowed for create, but every existing component is
 * a real non-symlink object below the trusted Project root.
 */
export function resolveProjectPolicyResourcePath(
  root: string,
  candidate: string,
  fs: Readonly<{
    realpath(path: string): string
    lstat(path: string): {
      dev: bigint
      ino: bigint
      isDirectory(): boolean
      isSymbolicLink(): boolean
    }
    readdir(path: string): string[]
  }> = {
    realpath: path => realpathSync(path),
    lstat: path => lstatSync(path, { bigint: true }),
    readdir: path => readdirSync(path, { encoding: 'utf8' }),
  },
): {
  absolutePath: string
  relativePath: string
  seal: WorkspaceResourceSeal
} | null {
  const requestedRelativePath = normalizeProjectPolicyRelativePath(candidate)
  if (requestedRelativePath === null || isAbsolute(candidate)) return null
  let canonicalRoot: string
  try { canonicalRoot = fs.realpath(root) } catch { return null }
  if (canonicalRoot !== root) return null
  const components = requestedRelativePath === '.' ? [] : requestedRelativePath.split('/')
  const canonicalComponents: string[] = []
  const sealedComponents: Array<WorkspaceResourceSeal['components'][number]> = []
  let current = canonicalRoot
  let rootInfo: ReturnType<typeof fs.lstat>
  try {
    rootInfo = fs.lstat(canonicalRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null
    for (let index = 0; index < components.length; index++) {
      const requested = join(current, components[index]!)
      try {
        const info = fs.lstat(requested)
        if (info.isSymbolicLink()) return null
        if (index + 1 < components.length && !info.isDirectory()) return null
        const names = fs.readdir(current)
        const exactName = names.find((name) => name === components[index])
        const inodeNames = exactName === undefined
          ? names.filter((name) => {
              try {
                const entry = fs.lstat(join(current, name))
                return entry.dev === info.dev && entry.ino === info.ino
              } catch {
                return false
              }
            })
          : []
        const actualName = exactName ?? (inodeNames.length === 1 ? inodeNames[0] : undefined)
        if (actualName === undefined) return null
        const canonical = fs.realpath(join(current, actualName))
        if (dirname(canonical) !== current) return null
        canonicalComponents.push(actualName)
        sealedComponents.push({
          name: actualName,
          device: info.dev.toString(10),
          inode: info.ino.toString(10),
        })
        current = canonical
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && index + 1 === components.length) {
          canonicalComponents.push(components[index]!)
          current = requested
          break
        }
        return null
      }
    }
  } catch {
    return null
  }
  const fromRoot = relative(canonicalRoot, current)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null
  return {
    absolutePath: current,
    relativePath: canonicalComponents.length === 0 ? '.' : canonicalComponents.join('/'),
    seal: {
      rootDevice: rootInfo.dev.toString(10),
      rootInode: rootInfo.ino.toString(10),
      components: sealedComponents,
    },
  }
}

export interface WorkspaceResourceAdmissionContext {
  readonly sessionId?: string
  readonly turnId?: string
  readonly ordinal?: number
}

export interface WorkspaceResourceAdmissionRegistry {
  admit(
    context: WorkspaceResourceAdmissionContext,
    tool: string,
    candidate: string,
  ): { relativePath: string } | null
  consume(
    context: WorkspaceResourceAdmissionContext,
    tool: string,
    candidate: string,
  ): ResolvedWorkspacePath | null
}

function sameWorkspaceSeal(left: WorkspaceResourceSeal, right: WorkspaceResourceSeal): boolean {
  return left.rootDevice === right.rootDevice && left.rootInode === right.rootInode &&
    left.components.length === right.components.length &&
    left.components.every((component, index) => {
      const other = right.components[index]
      return other !== undefined && component.name === other.name &&
        component.device === other.device && component.inode === other.inode
    })
}

export function makeWorkspaceResourceAdmissionRegistry(input: Readonly<{
  root: string
  maxEntries?: number
}>): WorkspaceResourceAdmissionRegistry {
  const maximum = input.maxEntries ?? 10_000
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) {
    throw new Error('INVALID_WORKSPACE_RESOURCE_ADMISSION_LIMIT')
  }
  const admitted = new Map<string, Readonly<{
    relativePath: string
    seal: WorkspaceResourceSeal
  }>>()
  const key = (
    context: WorkspaceResourceAdmissionContext,
    tool: string,
    candidate: string,
  ): string | null => typeof context.sessionId === 'string' &&
    typeof context.turnId === 'string' && Number.isSafeInteger(context.ordinal) &&
    (context.ordinal ?? 0) > 0
      ? `${context.sessionId}\0${context.turnId}\0${context.ordinal}\0${tool}\0${candidate}`
      : null
  return Object.freeze({
    admit(context: WorkspaceResourceAdmissionContext, tool: string, candidate: string) {
      const admissionKey = key(context, tool, candidate)
      if (admissionKey === null) return null
      const resolved = resolveProjectPolicyResourcePath(input.root, candidate)
      if (resolved === null) return null
      if (admitted.size >= maximum) admitted.clear()
      admitted.set(admissionKey, { relativePath: resolved.relativePath, seal: resolved.seal })
      return { relativePath: resolved.relativePath }
    },
    consume(context: WorkspaceResourceAdmissionContext, tool: string, candidate: string) {
      const admissionKey = key(context, tool, candidate)
      if (admissionKey === null) return null
      const previous = admitted.get(admissionKey)
      admitted.delete(admissionKey)
      if (previous === undefined) return null
      const current = resolveProjectPolicyResourcePath(input.root, candidate)
      if (current === null || current.relativePath !== previous.relativePath ||
        !sameWorkspaceSeal(current.seal, previous.seal)) return null
      return { absolutePath: current.absolutePath, seal: previous.seal }
    },
  })
}

function clone(state: ProjectPolicyStateV1): ProjectPolicyStateV1 {
  return {
    schemaVersion: 1,
    revision: state.revision,
    overlays: state.overlays.map((overlay) => ({
      projectId: overlay.projectId,
      relativePath: overlay.relativePath,
      modes: [...overlay.modes],
    })),
  }
}

function validate(value: unknown): ProjectPolicyStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
  }
  const candidate = value as Partial<ProjectPolicyStateV1>
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision ?? -1) < 0 || !Array.isArray(candidate.overlays) ||
    candidate.overlays.length > MAX_OVERLAYS ||
    Object.keys(candidate).some((key) => !['schemaVersion', 'revision', 'overlays'].includes(key))) {
    throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
  }
  const identities = new Set<string>()
  for (const raw of candidate.overlays) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
    }
    const overlay = raw as Partial<ProjectPolicyOverlayV1>
    const relativePath = overlay.relativePath
    const normalizedPath = typeof relativePath === 'string'
      ? normalizeProjectPolicyRelativePath(relativePath)
      : relativePath === null ? null : undefined
    const identity = `${overlay.projectId ?? ''}\0${normalizedPath ?? ''}`
    if (typeof overlay.projectId !== 'string' || !SAFE_ID.test(overlay.projectId) ||
      normalizedPath === undefined || normalizedPath !== relativePath ||
      !Array.isArray(overlay.modes) || overlay.modes.length < 1 ||
      overlay.modes.length > PROJECT_POLICY_MODES.length ||
      overlay.modes.some((mode) => !isProjectPolicyMode(mode)) ||
      new Set(overlay.modes).size !== overlay.modes.length || identities.has(identity) ||
      Object.keys(overlay).some((key) => !['projectId', 'relativePath', 'modes'].includes(key))) {
      throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
    }
    identities.add(identity)
  }
  return clone(candidate as ProjectPolicyStateV1)
}

function isAtOrBelow(candidate: string, ancestor: string): boolean {
  return ancestor === '.' || candidate === ancestor || candidate.startsWith(`${ancestor}/`)
}

function isDeleteLike(tool: string, args: Readonly<Record<string, unknown>>): boolean {
  if (tool === 'track_task' && args['action'] === 'drop') return true
  if (tool === 'bash' || tool.startsWith('mcp:write:')) return true
  return /(?:delete|remove|drop)/iu.test(tool)
}

function makeStore(input: {
  initial?: ProjectPolicyStateV1
  save(state: ProjectPolicyStateV1): void
  fenced?: () => boolean
}): ProjectPolicyOverlayStore {
  let state = validate(input.initial ?? { schemaVersion: 1, revision: 0, overlays: [] })
  const publish = (candidate: ProjectPolicyStateV1): void => {
    const next = validate(candidate)
    input.save(next)
    state = next
  }
  return Object.freeze<ProjectPolicyOverlayStore>({
    revision: () => state.revision,
    snapshot: () => clone(state),
    tighten(request) {
      if (input.fenced?.() === true) {
        throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
      }
      if (request.expectedRevision !== state.revision) return 'stale'
      const normalizedPath = request.relativePath === null
        ? null
        : normalizeProjectPolicyRelativePath(request.relativePath)
      if (!SAFE_ID.test(request.projectId) || normalizedPath !== request.relativePath ||
        !isProjectPolicyMode(request.mode)) {
        throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
      }
      const existing = state.overlays.find((overlay) =>
        overlay.projectId === request.projectId && overlay.relativePath === normalizedPath)
      if (existing?.modes.includes(request.mode) === true) return 'already-strict'
      const overlays = state.overlays.filter((overlay) => overlay !== existing)
      overlays.push({
        projectId: request.projectId,
        relativePath: normalizedPath,
        modes: [...(existing?.modes ?? []), request.mode]
          .sort((a, b) => PROJECT_POLICY_MODES.indexOf(a) - PROJECT_POLICY_MODES.indexOf(b)),
      })
      publish({ schemaVersion: 1, revision: state.revision + 1, overlays })
      return 'tightened'
    },
    relax(request) {
      if (input.fenced?.() === true) {
        throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
      }
      if (request.expectedRevision !== state.revision) return 'stale'
      const normalizedPath = request.relativePath === null
        ? null
        : normalizeProjectPolicyRelativePath(request.relativePath)
      if (!SAFE_ID.test(request.projectId) || normalizedPath !== request.relativePath ||
        !isProjectPolicyMode(request.mode)) {
        throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
      }
      const existing = state.overlays.find((overlay) =>
        overlay.projectId === request.projectId && overlay.relativePath === normalizedPath)
      if (existing === undefined || !existing.modes.includes(request.mode)) return 'already-absent'
      const modes = existing.modes.filter((mode) => mode !== request.mode)
      const overlays = state.overlays.filter((overlay) => overlay !== existing)
      if (modes.length > 0) overlays.push({ ...existing, modes })
      publish({ schemaVersion: 1, revision: state.revision + 1, overlays })
      return 'relaxed'
    },
    evaluate(request) {
      // This operation only mints the existing purpose-bound Telegram delete
      // preview. Asking here as well would create two confirmations for one
      // deletion; physical Session deletion remains impossible without its tap.
      if (request.tool === 'configure_agent' &&
        request.args['operation'] === 'session.request-delete') {
        return { decision: 'unchanged' }
      }
      if (input.fenced?.() === true) return { decision: 'deny' }
      const modes = new Set<ProjectPolicyMode>()
      for (const overlay of state.overlays) {
        if (overlay.projectId !== request.projectId) continue
        if (overlay.relativePath !== null &&
          (request.relativePath === null || !isAtOrBelow(request.relativePath, overlay.relativePath))) {
          continue
        }
        for (const mode of overlay.modes) modes.add(mode)
      }
      // Bash and MCP are opaque capability classes here. A lexical command
      // denylist cannot prove absence of sockets, so strict no-egress drops the
      // whole class, including MCP tools whose server annotation says read-only.
      const opaqueEgress = request.tool === 'bash' || request.tool.startsWith('mcp:')
      const scheduledEgress = request.tool === 'set_trigger' &&
        request.args['kind'] === 'watch' && typeof request.args['probe'] === 'string' &&
        request.args['probe'].startsWith('http:')
      if (modes.has('no-egress') && (request.outboundSink || opaqueEgress || scheduledEgress)) {
        return { decision: 'deny' }
      }
      const acting = request.effect === 'write' || request.effect === 'execute' ||
        request.effect === 'delegate'
      if (modes.has('read-only') && acting) return { decision: 'deny' }
      if (modes.has('ask-before-delete') && isDeleteLike(request.tool, request.args)) {
        return { decision: 'ask', summary: 'Удалить выбранные данные? После этого вернуть их может быть нельзя.' }
      }
      if (modes.has('confirm-writes') && acting) {
        return { decision: 'ask', summary: 'Изменить данные в этом проекте?' }
      }
      return { decision: 'unchanged' }
    },
  })
}

export function makeMemoryProjectPolicyOverlayStore(input: {
  initial?: ProjectPolicyStateV1
  save?: (state: ProjectPolicyStateV1) => void
} = {}): ProjectPolicyOverlayStore {
  return makeStore({
    ...(input.initial === undefined ? {} : { initial: input.initial }),
    save: input.save ?? (() => undefined),
  })
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeProjectPolicyOverlayStore(input: { path: string }): ProjectPolicyOverlayStore {
  if (!isAbsolute(input.path) || normalizeFsPath(input.path) !== input.path || input.path.includes('\0')) {
    throw new ProjectPolicyOverlayError('INSECURE_PROJECT_POLICY_STORE')
  }
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = lstatSync(directory)
  const owner = typeof process.getuid !== 'function' || directoryInfo.uid === process.getuid()
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    realpathSync(directory) !== directory || !owner || (directoryInfo.mode & 0o077) !== 0) {
    throw new ProjectPolicyOverlayError('INSECURE_PROJECT_POLICY_STORE')
  }
  const guardPath = `${input.path}.safe`
  if (existsSync(guardPath)) {
    throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
  }
  let initial: ProjectPolicyStateV1 = { schemaVersion: 1, revision: 0, overlays: [] }
  if (existsSync(input.path)) {
    const info = lstatSync(input.path)
    const fileOwner = typeof process.getuid !== 'function' || info.uid === process.getuid()
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !fileOwner ||
      (info.mode & 0o077) !== 0 || info.size < 1 || info.size > MAX_BYTES) {
      throw new ProjectPolicyOverlayError('INSECURE_PROJECT_POLICY_STORE')
    }
    try { initial = validate(JSON.parse(readFileSync(input.path, 'utf8')) as unknown) } catch (error) {
      if (error instanceof ProjectPolicyOverlayError) throw error
      throw new ProjectPolicyOverlayError('CORRUPT_PROJECT_POLICY_STORE')
    }
  }
  let fenced = false
  const writeAtomic = (path: string, content: string): void => {
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      writeFileSync(temporary, content, {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      syncPath(temporary)
      renameSync(temporary, path)
      syncPath(directory)
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
  return makeStore({
    initial,
    fenced: () => fenced,
    save: (state) => {
      fenced = true
      try {
        writeAtomic(guardPath, '{"schemaVersion":1,"state":"fenced"}\n')
        writeAtomic(input.path, JSON.stringify(state, null, 2) + '\n')
        unlinkSync(guardPath)
        syncPath(directory)
        fenced = false
      } catch (error) {
        // A durable or possibly durable guard makes every in-process decision
        // deny and prevents restart until an operator repairs the state.
        throw error
      }
    },
  })
}

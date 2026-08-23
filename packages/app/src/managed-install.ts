import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MANAGED_ORIGIN = 'https://github.com/veeskelad/aisy-agent.git'
export const MANAGED_BRANCH = 'master'

const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const GENERATION = /^g-[a-f0-9]{16,64}$/
const GC_GENERATION = /^\.gc-(g-[a-f0-9]{16,64})$/
const NEW_GENERATION = /^\.new-(g-[a-f0-9]{16,64})$/
const PHASES = new Set(['PREPARED', 'VERIFIED', 'SWITCHED'])
const RUNTIME_ROOTS = [
  'node_modules',
  'packages/app/dist',
  'packages/app/node_modules',
  'packages/core-ts/dist',
  'packages/core-ts/node_modules',
  'packages/telegram-gw/dist',
  'packages/telegram-gw/node_modules',
] as const

export type ManagedUpdateCode =
  | 'UPDATE_NOT_MANAGED'
  | 'UPDATE_SOURCE_REFUSED'
  | 'UPDATE_HISTORY_REFUSED'
  | 'UPDATE_LAUNCHER_REFUSED'
  | 'UPDATE_BUSY'
  | 'UPDATE_BUILD_FAILED'
  | 'UPDATE_DOCTOR_FAILED'
  | 'UPDATE_STATE_REFUSED'

export class ManagedUpdateFailure extends Error {
  constructor(readonly code: ManagedUpdateCode) {
    super(code)
  }
}

type Phase = 'PREPARED' | 'VERIFIED' | 'SWITCHED'

interface Journal {
  schemaVersion: 1
  operation: 'bootstrap' | 'update' | 'rollback'
  phase: Phase
  oldCommit: string | null
  newCommit: string
}

export interface ActiveGeneration {
  id: string
  current: string
  previous: string | null
}

export interface ManagedUpdatePorts {
  effectiveUid(): number
  fetchHead(root: string): string
  isAncestor(root: string, current: string, target: string): boolean
  prepareRelease(root: string, commit: string): void
  verifyRelease(root: string, commit: string, mode: 'bootstrap' | 'update' | 'rollback'): void
  removeRelease(root: string, commit: string): void
  pruneWorktrees(root: string): void
  withOperationLock<T>(root: string, body: () => T): T
  generationId(): string
  fault(point: string): void
}

interface OperationInput {
  root: string
  binDir: string
}

interface BootstrapInput extends OperationInput {
  commit: string
  recordIntegrity?: boolean
}

interface UpdateInput extends OperationInput {
  allowRewrite?: string
}

function canonicalJson(value: object): string {
  return JSON.stringify(value) + '\n'
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function safeAbsolute(path: string): void {
  if (
    !isAbsolute(path) || path !== resolve(path) || path.includes('\0') ||
    path.includes('\n') || path.includes('\r')
  ) {
    throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  }
}

function safeDirectory(path: string, uid: number): void {
  try {
    safeAbsolute(path)
    const info = lstatSync(path)
    if (
      !info.isDirectory() || info.isSymbolicLink() || info.uid !== uid ||
      (info.mode & 0o022) !== 0 || realpathSync(path) !== path
    ) {
      throw new Error('unsafe')
    }
  } catch (error) {
    if (error instanceof ManagedUpdateFailure) throw error
    throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  }
}

function safeAncestorChain(path: string, uid: number): void {
  let current = path
  try {
    safeAbsolute(path)
    while (true) {
      const info = lstatSync(current)
      if (
        !info.isDirectory() || info.isSymbolicLink() ||
        (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022) !== 0 ||
        realpathSync(current) !== current
      ) throw new Error('unsafe ancestor')
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  } catch (error) {
    if (error instanceof ManagedUpdateFailure) throw error
    throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function atomicFile(path: string, content: string, mode: number): void {
  const parent = dirname(path)
  const temporary = join(parent, `.${basename(path)}.tmp-${process.pid}`)
  let descriptor = -1
  try {
    descriptor = openSync(temporary, 'wx', mode)
    writeFileSync(descriptor, content, 'utf8')
    fchmodSync(descriptor, mode)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = -1
    renameSync(temporary, path)
    fsyncDirectory(parent)
  } catch (error) {
    if (descriptor >= 0) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* exact temporary may be absent */ }
    throw error
  }
}

function parseJournal(path: string): Journal | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw) > 2048) throw new Error('oversize')
    const value: unknown = JSON.parse(raw)
    if (!exactObject(value, ['schemaVersion', 'operation', 'phase', 'oldCommit', 'newCommit'])) {
      throw new Error('schema')
    }
    if (
      value.schemaVersion !== 1 ||
      !['bootstrap', 'update', 'rollback'].includes(String(value.operation)) ||
      !PHASES.has(String(value.phase)) ||
      (value.oldCommit !== null && (typeof value.oldCommit !== 'string' || !COMMIT.test(value.oldCommit))) ||
      typeof value.newCommit !== 'string' || !COMMIT.test(value.newCommit) ||
      canonicalJson(value) !== raw
    ) {
      throw new Error('invalid')
    }
    return value as unknown as Journal
  } catch {
    throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
  }
}

function writeJournal(path: string, journal: Journal): void {
  atomicFile(path, canonicalJson(journal), 0o600)
}

function clearJournal(path: string): void {
  if (!existsSync(path)) return
  unlinkSync(path)
  fsyncDirectory(dirname(path))
}

function safeCommit(value: string): string {
  if (!COMMIT.test(value)) throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  return value
}

function releasePath(root: string, commit: string): string {
  return join(root, 'releases', safeCommit(commit))
}

function runtimeDigest(root: string, commit: string): string {
  const release = releasePath(root, commit)
  const hash = createHash('sha256').update('aisy.managed-runtime.v1\0')
  const walk = (path: string): void => {
    const relative = path.slice(release.length + 1)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path)
      const resolved = resolve(dirname(path), target)
      if (resolved !== release && !resolved.startsWith(`${release}${sep}`)) {
        throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
      }
      hash.update(`L\0${relative}\0${target}\0`)
      return
    }
    if (info.isDirectory()) {
      hash.update(`D\0${relative}\0${info.mode & 0o777}\0`)
      for (const entry of readdirSync(path).sort()) walk(join(path, entry))
      return
    }
    if (!info.isFile() || info.nlink !== 1) {
      throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
    }
    const content = readFileSync(path)
    hash.update(`F\0${relative}\0${info.mode & 0o777}\0${content.length}\0`)
    hash.update(content)
  }
  for (const relative of RUNTIME_ROOTS) walk(join(release, relative))
  return hash.digest('hex')
}

export function recordManagedReleaseIntegrity(root: string, commit: string): void {
  const uid = process.geteuid?.() ?? 0
  safeAncestorChain(root, uid)
  safeDirectory(root, uid)
  const integrityRoot = join(root, 'integrity')
  if (!existsSync(integrityRoot)) mkdirSync(integrityRoot, { mode: 0o700 })
  safeDirectory(integrityRoot, uid)
  atomicFile(join(integrityRoot, `${safeCommit(commit)}.json`), canonicalJson({
    schemaVersion: 1,
    commit,
    digest: runtimeDigest(root, commit),
  }), 0o600)
}

export function verifyManagedReleaseIntegrity(root: string, commit: string): void {
  const path = join(root, 'integrity', `${safeCommit(commit)}.json`)
  try {
    const info = lstatSync(path)
    if (
      !info.isFile() || info.isSymbolicLink() || info.uid !== (process.geteuid?.() ?? 0) ||
      info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 512
    ) throw new Error('integrity metadata')
    const raw = readFileSync(path, 'utf8')
    const value: unknown = JSON.parse(raw)
    if (!exactObject(value, ['schemaVersion', 'commit', 'digest']) ||
      value.schemaVersion !== 1 || value.commit !== commit ||
      typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      canonicalJson(value) !== raw || value.digest !== runtimeDigest(root, commit)) {
      throw new Error('integrity')
    }
  } catch {
    throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  }
}

function readGeneration(root: string, activeRequired = true): ActiveGeneration | null {
  const activePath = join(root, 'active')
  if (!pathPresent(activePath)) {
    if (activeRequired) throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    return null
  }
  try {
    const activeInfo = lstatSync(activePath)
    if (!activeInfo.isSymbolicLink()) throw new Error('active')
    const activeTarget = readlinkSync(activePath)
    const expectedPrefix = `generations${sep}`
    if (!activeTarget.startsWith(expectedPrefix)) throw new Error('target')
    const id = activeTarget.slice(expectedPrefix.length)
    if (!GENERATION.test(id) || activeTarget.includes('..')) throw new Error('id')
    const generationRoot = join(root, 'generations', id)
    safeDirectory(generationRoot, process.getuid?.() ?? -1)
    const current = readReleaseLink(root, generationRoot, 'current')
    const previous = pathPresent(join(generationRoot, 'previous'))
      ? readReleaseLink(root, generationRoot, 'previous')
      : null
    return { id, current, previous }
  } catch (error) {
    if (error instanceof ManagedUpdateFailure) throw error
    throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
  }
}

function readReleaseLink(root: string, generationRoot: string, name: string): string {
  const path = join(generationRoot, name)
  const info = lstatSync(path)
  if (!info.isSymbolicLink()) throw new Error('release-link')
  const target = readlinkSync(path)
  const absolute = resolve(generationRoot, target)
  const releases = join(root, 'releases')
  if (dirname(absolute) !== releases || !COMMIT.test(basename(absolute))) throw new Error('release-target')
  safeDirectory(absolute, process.getuid?.() ?? -1)
  return basename(absolute)
}

function assertLayout(root: string, uid: number, allowMissingActive = false): ActiveGeneration | null {
  safeAncestorChain(root, uid)
  safeDirectory(root, uid)
  safeDirectory(join(root, 'repository.git'), uid)
  safeDirectory(join(root, 'releases'), uid)
  safeDirectory(join(root, 'generations'), uid)
  return readGeneration(root, !allowMissingActive)
}

function launcherContent(root: string): string {
  const binary = pathToFileURL(join(root, 'active', 'current', 'packages', 'app', 'dist', 'bin', 'aisy.js')).href
  return `#!/usr/bin/env node\nawait import(${JSON.stringify(binary)})\n`
}

function publishLauncher(root: string, binDir: string, uid: number): void {
  safeAncestorChain(binDir, uid)
  safeDirectory(binDir, uid)
  const path = join(binDir, 'aisy')
  const content = launcherContent(root)
  if (pathPresent(path)) {
    try {
      const info = lstatSync(path)
      if (
        !info.isFile() || info.isSymbolicLink() || info.uid !== uid ||
        (info.mode & 0o022) !== 0 || readFileSync(path, 'utf8') !== content
      ) throw new Error('collision')
      return
    } catch {
      throw new ManagedUpdateFailure('UPDATE_LAUNCHER_REFUSED')
    }
  }
  atomicFile(path, content, 0o755)
  chmodSync(path, 0o755)
  fsyncDirectory(binDir)
}

function assertLauncherAvailable(root: string, binDir: string, uid: number): void {
  safeAncestorChain(binDir, uid)
  safeDirectory(binDir, uid)
  const path = join(binDir, 'aisy')
  if (!pathPresent(path)) return
  try {
    const info = lstatSync(path)
    if (
      !info.isFile() || info.isSymbolicLink() || info.uid !== uid ||
      (info.mode & 0o022) !== 0 || readFileSync(path, 'utf8') !== launcherContent(root)
    ) throw new Error('collision')
  } catch {
    throw new ManagedUpdateFailure('UPDATE_LAUNCHER_REFUSED')
  }
}

function recoverJournal(root: string): void {
  const path = join(root, 'update-state.json')
  const journal = parseJournal(path)
  if (journal === null) return
  const active = readGeneration(root, false)
  if (journal.phase === 'SWITCHED' || active?.current === journal.newCommit) {
    if (active?.current !== journal.newCommit || active.previous !== journal.oldCommit) {
      throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    }
    clearJournal(path)
    return
  }
  if (journal.phase === 'PREPARED' || journal.phase === 'VERIFIED') {
    if (
      (journal.oldCommit === null && active !== null) ||
      (journal.oldCommit !== null && active?.current !== journal.oldCommit)
    ) throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    clearJournal(path)
    return
  }
  throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
}

function publishGeneration(
  root: string,
  current: string,
  previous: string | null,
  ports: ManagedUpdatePorts,
): ActiveGeneration {
  const id = `g-${ports.generationId()}`
  if (!GENERATION.test(id)) throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
  const generationsRoot = join(root, 'generations')
  const generationRoot = join(root, 'generations', id)
  const newRoot = join(generationsRoot, `.new-${id}`)
  const temporary = join(root, `.active.tmp-${process.pid}`)
  try {
    mkdirSync(newRoot, { mode: 0o700 })
    ports.fault('generation:after-mkdir')
    symlinkSync(join('..', '..', 'releases', safeCommit(current)), join(newRoot, 'current'))
    if (previous !== null) {
      symlinkSync(join('..', '..', 'releases', safeCommit(previous)), join(newRoot, 'previous'))
    }
    fsyncDirectory(newRoot)
    ports.fault('generation:after-fsync')
    renameSync(newRoot, generationRoot)
    ports.fault('generation:after-rename')
    fsyncDirectory(generationsRoot)
    ports.fault('generation:after-dir-fsync')
    symlinkSync(join('generations', id), temporary)
    fsyncDirectory(root)
    ports.fault('active:before-rename')
    renameSync(temporary, join(root, 'active'))
    ports.fault('active:after-rename')
    fsyncDirectory(root)
    ports.fault('active:after-dir-fsync')
    return { id, current, previous }
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* renamed or absent */ }
    if (error instanceof ManagedUpdateFailure) throw error
    throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
  }
}

function removeGenerationTree(
  root: string,
  generationRoot: string,
  uid: number,
  afterUnlink: () => void = () => undefined,
): void {
  const generationsRoot = join(root, 'generations')
  safeDirectory(generationRoot, uid)
  const names = readdirSync(generationRoot).sort()
  if (names.some(name => name !== 'current' && name !== 'previous')) {
    throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
  }
  for (const name of names) {
    readReleaseLink(root, generationRoot, name)
    unlinkSync(join(generationRoot, name))
    fsyncDirectory(generationRoot)
    afterUnlink()
  }
  rmdirSync(generationRoot)
  fsyncDirectory(generationsRoot)
}

function cleanupIntegrityTemporaries(root: string, uid: number): void {
  const integrityRoot = join(root, 'integrity')
  if (!pathPresent(integrityRoot)) return
  safeDirectory(integrityRoot, uid)
  for (const entry of readdirSync(integrityRoot, { withFileTypes: true })) {
    if (!/^\.[a-f0-9]{40}(?:[a-f0-9]{24})?\.json\.tmp-[1-9][0-9]*$/.test(entry.name)) {
      continue
    }
    const path = join(integrityRoot, entry.name)
    const info = lstatSync(path)
    if (
      !entry.isFile() || entry.isSymbolicLink() || info.uid !== uid || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.size > 512
    ) throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    unlinkSync(path)
    fsyncDirectory(integrityRoot)
  }
}

function operation<T>(root: string, ports: ManagedUpdatePorts, body: () => T): T {
  return ports.withOperationLock(root, () => {
    recoverJournal(root)
    return body()
  })
}

function cleanupUnderLock(root: string, ports: ManagedUpdatePorts): ActiveGeneration {
  const active = readGeneration(root) as ActiveGeneration
  const generationsRoot = join(root, 'generations')
  const removeGenerationResidue = (generationRoot: string): void => {
    removeGenerationTree(
      root, generationRoot, ports.effectiveUid(),
      () => ports.fault('cleanup:generation-after-unlink'),
    )
  }
  for (const entry of readdirSync(generationsRoot, { withFileTypes: true })) {
    const residue = GC_GENERATION.exec(entry.name)
    const unpublished = NEW_GENERATION.exec(entry.name)
    if (
      !entry.isDirectory() ||
      (!GENERATION.test(entry.name) && residue === null && unpublished === null)
    ) {
      throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    }
    if (residue !== null || unpublished !== null) {
      removeGenerationResidue(join(generationsRoot, entry.name))
      continue
    }
    if (entry.name === active.id) continue
    const generationRoot = join(generationsRoot, entry.name)
    safeDirectory(generationRoot, ports.effectiveUid())
    readReleaseLink(root, generationRoot, 'current')
    const names = readdirSync(generationRoot).sort()
    if (names.join('\0') !== 'current' && names.join('\0') !== 'current\0previous') {
      throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    }
    if (names.includes('previous')) readReleaseLink(root, generationRoot, 'previous')
    const residueRoot = join(generationsRoot, `.gc-${entry.name}`)
    renameSync(generationRoot, residueRoot)
    fsyncDirectory(generationsRoot)
    ports.fault('cleanup:generation-after-rename')
    removeGenerationResidue(residueRoot)
  }
  const retained = new Set([active.current, ...(active.previous === null ? [] : [active.previous])])
  const releasesRoot = join(root, 'releases')
  ports.pruneWorktrees(root)
  for (const entry of readdirSync(releasesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !COMMIT.test(entry.name)) {
      throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    }
    if (retained.has(entry.name)) continue
    safeDirectory(join(releasesRoot, entry.name), ports.effectiveUid())
    ports.removeRelease(root, entry.name)
    if (pathPresent(join(releasesRoot, entry.name))) {
      throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    }
    fsyncDirectory(releasesRoot)
    ports.fault('cleanup:release-after-remove')
  }
  const integrityRoot = join(root, 'integrity')
  if (pathPresent(integrityRoot)) {
    cleanupIntegrityTemporaries(root, ports.effectiveUid())
    safeDirectory(integrityRoot, ports.effectiveUid())
    for (const entry of readdirSync(integrityRoot, { withFileTypes: true })) {
      const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\.json$/.exec(entry.name)
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
      }
      const commit = match[1] as string
      if (pathPresent(join(releasesRoot, commit))) continue
      const integrityPath = join(integrityRoot, entry.name)
      const info = lstatSync(integrityPath)
      if (
        info.uid !== ports.effectiveUid() || info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 || info.size > 512
      ) throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
      unlinkSync(integrityPath)
      fsyncDirectory(integrityRoot)
      ports.fault('cleanup:integrity-after-unlink')
    }
  }
  return active
}

export function cleanupManagedInstall(
  input: OperationInput,
  ports: ManagedUpdatePorts = nodeManagedUpdatePorts(),
): ActiveGeneration {
  const uid = ports.effectiveUid()
  if (uid === 0) throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  assertLayout(input.root, uid)
  assertLauncherAvailable(input.root, input.binDir, uid)
  return operation(input.root, ports, () => cleanupUnderLock(input.root, ports))
}

export function bootstrapManagedInstall(
  input: BootstrapInput,
  ports: ManagedUpdatePorts = nodeManagedUpdatePorts(),
): ActiveGeneration {
  safeCommit(input.commit)
  const uid = ports.effectiveUid()
  if (uid === 0) throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  assertLayout(input.root, uid, true)
  assertLauncherAvailable(input.root, input.binDir, uid)
  return operation(input.root, ports, () => {
    const existing = readGeneration(input.root, false)
    if (existing !== null) {
      if (input.recordIntegrity === true) {
        throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
      }
      publishLauncher(input.root, input.binDir, uid)
      return existing
    }
    const generationsRoot = join(input.root, 'generations')
    for (const entry of readdirSync(generationsRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        (!GENERATION.test(entry.name) && !GC_GENERATION.test(entry.name) &&
          !NEW_GENERATION.test(entry.name))
      ) throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
      removeGenerationTree(
        input.root, join(generationsRoot, entry.name), ports.effectiveUid(),
      )
    }
    cleanupIntegrityTemporaries(input.root, uid)
    safeDirectory(releasePath(input.root, input.commit), uid)
    if (input.recordIntegrity === true) {
      try {
        recordManagedReleaseIntegrity(input.root, input.commit)
      } catch (error) {
        if (error instanceof ManagedUpdateFailure) throw error
        throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
      }
    }
    ports.verifyRelease(input.root, input.commit, 'bootstrap')
    const journalPath = join(input.root, 'update-state.json')
    writeJournal(journalPath, {
      schemaVersion: 1, operation: 'bootstrap', phase: 'VERIFIED',
      oldCommit: null, newCommit: input.commit,
    })
    ports.fault('journal:after-verified')
    const generation = publishGeneration(input.root, input.commit, null, ports)
    writeJournal(journalPath, {
      schemaVersion: 1, operation: 'bootstrap', phase: 'SWITCHED',
      oldCommit: null, newCommit: input.commit,
    })
    clearJournal(journalPath)
    publishLauncher(input.root, input.binDir, uid)
    return generation
  })
}

export function updateManagedInstall(
  input: UpdateInput,
  ports: ManagedUpdatePorts = nodeManagedUpdatePorts(),
): ActiveGeneration {
  const uid = ports.effectiveUid()
  if (uid === 0) throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  assertLayout(input.root, uid)
  assertLauncherAvailable(input.root, input.binDir, uid)
  return operation(input.root, ports, () => {
    const active = cleanupUnderLock(input.root, ports)
    let target: string
    try {
      target = safeCommit(ports.fetchHead(input.root))
    } catch (error) {
      if (error instanceof ManagedUpdateFailure) throw error
      throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
    }
    if (target === active.current) {
      if (input.allowRewrite !== undefined) {
        throw new ManagedUpdateFailure('UPDATE_HISTORY_REFUSED')
      }
      publishLauncher(input.root, input.binDir, uid)
      return active
    }
    let descendant: boolean
    try {
      descendant = ports.isAncestor(input.root, active.current, target)
    } catch {
      throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
    }
    if (!descendant) {
      if (input.allowRewrite !== target) throw new ManagedUpdateFailure('UPDATE_HISTORY_REFUSED')
    } else if (input.allowRewrite !== undefined) {
      throw new ManagedUpdateFailure('UPDATE_HISTORY_REFUSED')
    }
    const journalPath = join(input.root, 'update-state.json')
    if (target === active.previous) {
      try {
        ports.verifyRelease(input.root, target, 'update')
      } catch (error) {
        if (error instanceof ManagedUpdateFailure) throw error
        throw new ManagedUpdateFailure('UPDATE_DOCTOR_FAILED')
      }
      writeJournal(journalPath, {
        schemaVersion: 1, operation: 'update', phase: 'VERIFIED',
        oldCommit: active.current, newCommit: target,
      })
      ports.fault('journal:after-verified')
      const generation = publishGeneration(input.root, target, active.current, ports)
      writeJournal(journalPath, {
        schemaVersion: 1, operation: 'update', phase: 'SWITCHED',
        oldCommit: active.current, newCommit: target,
      })
      clearJournal(journalPath)
      publishLauncher(input.root, input.binDir, uid)
      return generation
    }
    try {
      ports.prepareRelease(input.root, target)
    } catch (error) {
      if (error instanceof ManagedUpdateFailure) throw error
      throw new ManagedUpdateFailure('UPDATE_BUILD_FAILED')
    }
    safeDirectory(releasePath(input.root, target), uid)
    writeJournal(journalPath, {
      schemaVersion: 1, operation: 'update', phase: 'PREPARED',
      oldCommit: active.current, newCommit: target,
    })
    ports.fault('journal:after-prepared')
    try {
      ports.verifyRelease(input.root, target, 'update')
    } catch (error) {
      if (error instanceof ManagedUpdateFailure) throw error
      throw new ManagedUpdateFailure('UPDATE_DOCTOR_FAILED')
    }
    writeJournal(journalPath, {
      schemaVersion: 1, operation: 'update', phase: 'VERIFIED',
      oldCommit: active.current, newCommit: target,
    })
    ports.fault('journal:after-verified')
    const generation = publishGeneration(input.root, target, active.current, ports)
    writeJournal(journalPath, {
      schemaVersion: 1, operation: 'update', phase: 'SWITCHED',
      oldCommit: active.current, newCommit: target,
    })
    clearJournal(journalPath)
    publishLauncher(input.root, input.binDir, uid)
    return generation
  })
}

export function rollbackManagedInstall(
  input: OperationInput,
  ports: ManagedUpdatePorts = nodeManagedUpdatePorts(),
): ActiveGeneration {
  const uid = ports.effectiveUid()
  if (uid === 0) throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
  assertLayout(input.root, uid)
  assertLauncherAvailable(input.root, input.binDir, uid)
  return operation(input.root, ports, () => {
    const active = cleanupUnderLock(input.root, ports)
    if (active.previous === null) throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
    try {
      ports.verifyRelease(input.root, active.previous, 'rollback')
    } catch (error) {
      if (error instanceof ManagedUpdateFailure) throw error
      throw new ManagedUpdateFailure('UPDATE_DOCTOR_FAILED')
    }
    const journalPath = join(input.root, 'update-state.json')
    writeJournal(journalPath, {
      schemaVersion: 1, operation: 'rollback', phase: 'VERIFIED',
      oldCommit: active.current, newCommit: active.previous,
    })
    const generation = publishGeneration(input.root, active.previous, active.current, ports)
    writeJournal(journalPath, {
      schemaVersion: 1, operation: 'rollback', phase: 'SWITCHED',
      oldCommit: active.current, newCommit: active.previous,
    })
    clearJournal(journalPath)
    publishLauncher(input.root, input.binDir, uid)
    return generation
  })
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
  for (const key of ['HOME', 'TMPDIR', 'COREPACK_HOME', 'PNPM_HOME', 'XDG_CACHE_HOME', 'AISY_HOME']) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...commandEnvironment(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function command(
  commandName: string,
  args: string[],
  cwd = '/',
  env: NodeJS.ProcessEnv = commandEnvironment(),
): string {
  try {
    return execFileSync(commandName, args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000,
      env,
    }).trim()
  } catch {
    throw new Error('command failed')
  }
}

function git(root: string, args: string[]): string {
  return command('/usr/bin/git', [`--git-dir=${join(root, 'repository.git')}`, ...args], '/', gitEnvironment())
}

function workingGit(path: string, args: string[]): string {
  return command('/usr/bin/git', ['-C', path, ...args], '/', gitEnvironment())
}

function gitBytes(root: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync('/usr/bin/git', [`--git-dir=${join(root, 'repository.git')}`, ...args], {
    cwd: '/', env: gitEnvironment(), input, stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error('git bytes')
  return result.stdout
}

export function refuseGitLfsPointers(root: string, commit: string): void {
  const inventory = gitBytes(root, [
    'ls-tree', '-rz', '--full-tree',
    '--format=%(objectmode) %(objecttype) %(objectname) %(objectsize)', commit,
  ]).toString('utf8').split('\0').filter(Boolean)
  const small = new Map<string, number>()
  for (const record of inventory) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) (-|\d+)$/.exec(record)
    if (match === null || match[1] === '160000' || match[2] !== 'blob') {
      throw new Error('tree')
    }
    const object = match[3] as string
    const size = Number(match[4])
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('blob')
    if (size <= 4096) small.set(object, size)
  }
  if (small.size === 0) return
  const objects = [...small.keys()]
  const batch = gitBytes(root, ['cat-file', '--batch'], Buffer.from(`${objects.join('\n')}\n`))
  const header = Buffer.from('version https://git-lfs.github.com/spec/v1\n')
  let offset = 0
  for (const object of objects) {
    const lineEnd = batch.indexOf(0x0a, offset)
    if (lineEnd < 0) throw new Error('batch header')
    const line = batch.subarray(offset, lineEnd).toString('ascii')
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (\d+)$/.exec(line)
    const size = match === null ? -1 : Number(match[2])
    if (match?.[1] !== object || size !== small.get(object)) throw new Error('batch object')
    offset = lineEnd + 1
    const raw = batch.subarray(offset, offset + size)
    if (raw.length !== size || batch[offset + size] !== 0x0a) throw new Error('batch body')
    if (raw.subarray(0, header.length).equals(header)) throw new Error('lfs')
    offset += size + 1
  }
  if (offset !== batch.length) throw new Error('batch trailing')
}

interface RegisteredWorktree {
  head: string | null
  initializing: boolean
}

function registeredWorktree(root: string, path: string): RegisteredWorktree | null {
  const fields = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0')
  let worktree: string | null = null
  let head: string | null = null
  let detached = false
  let locked: string | null = null
  const finish = (): RegisteredWorktree | null => {
    if (worktree !== path) return null
    if (!detached) throw new Error('worktree registry')
    if (locked === null) {
      if (head === null || !COMMIT.test(head)) throw new Error('worktree registry')
      return { head, initializing: false }
    }
    if (
      locked !== 'initializing' ||
      (head !== null && !COMMIT.test(head) && !/^(?:0{40}|0{64})$/.test(head))
    ) throw new Error('worktree registry')
    return {
      head: head !== null && !/^(?:0{40}|0{64})$/.test(head) && COMMIT.test(head)
        ? head
        : null,
      initializing: true,
    }
  }
  for (const field of fields) {
    if (field === '') {
      const found = finish()
      if (found !== null) return found
      worktree = null
      head = null
      detached = false
      locked = null
    } else if (field.startsWith('worktree ')) {
      worktree = field.slice('worktree '.length)
    } else if (field.startsWith('HEAD ')) {
      head = field.slice('HEAD '.length)
    } else if (field === 'detached') {
      detached = true
    } else if (field.startsWith('locked ')) {
      locked = field.slice('locked '.length)
    }
  }
  return finish()
}

function recoverMissingInitializingWorktrees(root: string): void {
  const releasesRoot = join(root, 'releases')
  const fields = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0')
  const paths = fields
    .filter(field => field.startsWith('worktree '))
    .map(field => field.slice('worktree '.length))
  for (const path of paths) {
    if (dirname(path) !== releasesRoot || !COMMIT.test(basename(path)) || pathPresent(path)) {
      continue
    }
    const commit = basename(path)
    const registered = registeredWorktree(root, path)
    if (
      registered === null || !registered.initializing ||
      (registered.head !== null && registered.head !== commit)
    ) throw new Error('worktree registry')
    git(root, ['worktree', 'remove', '--force', '--force', path])
    git(root, ['worktree', 'prune', '--expire', 'now'])
    if (registeredWorktree(root, path) !== null) throw new Error('worktree registry')
  }
}

export function nodeManagedUpdatePorts(): ManagedUpdatePorts {
  return {
    effectiveUid: () => process.geteuid?.() ?? 0,
    fetchHead: (root) => {
      if (git(root, ['config', '--get', 'remote.origin.url']) !== MANAGED_ORIGIN) {
        throw new Error('origin')
      }
      git(root, [
        'fetch', '--prune', '--no-tags', 'origin',
        `+refs/heads/${MANAGED_BRANCH}:refs/remotes/origin/${MANAGED_BRANCH}`,
      ])
      return git(root, ['rev-parse', `refs/remotes/origin/${MANAGED_BRANCH}`])
    },
    isAncestor: (root, current, target) => {
      const result = spawnSync('/usr/bin/git', [
        `--git-dir=${join(root, 'repository.git')}`, 'merge-base', '--is-ancestor', current, target,
      ], { cwd: '/', env: gitEnvironment(), stdio: 'ignore', timeout: 30_000 })
      if (result.status === 0) return true
      if (result.status === 1) return false
      throw new Error('merge-base')
    },
    prepareRelease: (root, commit) => {
      try {
        const path = releasePath(root, commit)
        refuseGitLfsPointers(root, commit)
        if (!existsSync(path)) git(root, ['worktree', 'add', '--detach', path, commit])
        if (workingGit(path, ['rev-parse', 'HEAD']) !== commit) throw new Error('head')
        if (workingGit(path, ['status', '--porcelain']) !== '') throw new Error('dirty')
      } catch {
        throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
      }
      const path = releasePath(root, commit)
      command('corepack', [
        'pnpm', 'install', '--frozen-lockfile', '--config.package-import-method=copy',
      ], path)
      command('corepack', ['pnpm', '-r', 'build'], path)
      recordManagedReleaseIntegrity(root, commit)
    },
    verifyRelease: (root, commit, mode) => {
      const path = releasePath(root, commit)
      try {
        safeDirectory(path, process.geteuid?.() ?? 0)
        if (workingGit(path, ['rev-parse', 'HEAD']) !== commit) throw new Error('head')
        if (workingGit(path, ['status', '--porcelain']) !== '') throw new Error('dirty')
        verifyManagedReleaseIntegrity(root, commit)
      } catch (error) {
        if (error instanceof ManagedUpdateFailure) throw error
        throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
      }
      try {
        command(process.execPath, [
          join(path, 'packages', 'app', 'dist', 'bin', 'aisy.js'),
          'doctor', '--post-upgrade', '--json',
          ...(mode === 'bootstrap' ? ['--only=mcp,migration,sandbox'] : []),
        ], path)
        verifyManagedReleaseIntegrity(root, commit)
      } catch (error) {
        if (error instanceof ManagedUpdateFailure) throw error
        throw new ManagedUpdateFailure('UPDATE_DOCTOR_FAILED')
      }
    },
    removeRelease: (root, commit) => {
      const path = releasePath(root, commit)
      const registered = registeredWorktree(root, path)
      if (
        registered === null ||
        (registered.head !== null && registered.head !== commit)
      ) throw new Error('worktree registry')
      if (pathPresent(path)) safeDirectory(path, process.geteuid?.() ?? 0)
      git(root, [
        'worktree', 'remove', '--force',
        ...(registered.initializing ? ['--force'] : []),
        path,
      ])
      git(root, ['worktree', 'prune', '--expire', 'now'])
    },
    pruneWorktrees: root => {
      git(root, ['worktree', 'prune', '--expire', 'now'])
      recoverMissingInitializingWorktrees(root)
    },
    withOperationLock: (root, body) => {
      const lockPath = join(root, 'update.lock')
      const previousUmask = process.umask(0o077)
      let descriptor: number | null = null
      try {
        descriptor = openSync(
          lockPath,
          fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
          0o600,
        )
        const opened = fstatSync(descriptor)
        const named = lstatSync(lockPath)
        const uid = process.geteuid?.() ?? 0
        if (
          !opened.isFile() || named.isSymbolicLink() || !named.isFile() ||
          opened.dev !== named.dev || opened.ino !== named.ino || opened.uid !== uid ||
          opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
        ) throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
        const locked = spawnSync('/usr/bin/flock', ['-E', '75', '-n', '3'], {
          cwd: '/',
          env: { PATH: '/usr/bin:/bin' },
          stdio: ['ignore', 'ignore', 'ignore', descriptor],
          timeout: 30_000,
        })
        if (locked.status === 75) throw new ManagedUpdateFailure('UPDATE_BUSY')
        if (locked.error !== undefined || locked.status !== 0) {
          throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
        }
        return body()
      } finally {
        try {
          if (descriptor !== null) closeSync(descriptor)
        } finally {
          process.umask(previousUmask)
        }
      }
    },
    generationId: () => randomUUID().replaceAll('-', ''),
    fault: () => undefined,
  }
}

function inferInstallRoot(modulePath: string): string {
  const release = resolve(dirname(modulePath), '../../..')
  const releases = dirname(release)
  if (basename(releases) !== 'releases' || !COMMIT.test(basename(release))) {
    throw new ManagedUpdateFailure('UPDATE_NOT_MANAGED')
  }
  return dirname(releases)
}

export async function runManagedUpdateCli(
  argv: string[],
  io: { out(value: string): void; err(value: string): void } = {
    out: value => process.stdout.write(`${value}\n`),
    err: value => process.stderr.write(`${value}\n`),
  },
): Promise<number> {
  const operation = argv.length === 0
    ? { kind: 'update' as const }
    : argv.length === 1 && argv[0] === '--rollback'
      ? { kind: 'rollback' as const }
      : argv.length === 1 && argv[0] === '--cleanup'
        ? { kind: 'cleanup' as const }
        : argv.length === 1 && argv[0]?.startsWith('--allow-rewrite=') &&
          COMMIT.test(argv[0].slice('--allow-rewrite='.length))
          ? { kind: 'rewrite' as const, commit: argv[0].slice('--allow-rewrite='.length) }
          : null
  if (operation === null) {
    io.err('usage: aisy update [--rollback | --cleanup | --allow-rewrite=<full-sha>]')
    return 2
  }
  try {
    const modulePath = fileURLToPath(import.meta.url)
    const root = inferInstallRoot(modulePath)
    const binDir = dirname(process.argv[1] ?? join(homedir(), '.local', 'bin', 'aisy'))
    let generation: ActiveGeneration
    if (operation.kind === 'update') {
      generation = updateManagedInstall({ root, binDir })
    } else if (operation.kind === 'rollback') {
      generation = rollbackManagedInstall({ root, binDir })
    } else if (operation.kind === 'cleanup') {
      generation = cleanupManagedInstall({ root, binDir })
    } else {
      generation = updateManagedInstall({ root, binDir, allowRewrite: operation.commit })
    }
    io.out(`Aisy current=${generation.current} previous=${generation.previous ?? 'none'}`)
    return 0
  } catch (error) {
    const code = error instanceof ManagedUpdateFailure ? error.code : 'UPDATE_STATE_REFUSED'
    io.err(`aisy update: операция отклонена (${code})`)
    return 1
  }
}

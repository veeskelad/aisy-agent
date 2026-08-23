import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import {
  resolveRestrictedCloneTarget,
  type RestrictedCloneDnsPort,
  type RestrictedCloneTarget,
  type ProjectRecordV2,
  type ProjectRegistryV2Owner,
  type ProjectService,
  type ProjectServiceContextResult,
} from '@aisy/core'
import type { ConfinementTreeScanner } from './confinement-tree-scanner.js'

export interface ProjectProvisioningFs {
  exists(path: string): boolean
  createDirectoryExclusive(path: string): boolean
  createDirectory(path: string): void
  writeFileExclusive(path: string, content: string): void
  syncFile(path: string): void
  syncDirectory(path: string): void
  renameDirectory(from: string, to: string): void
  removeFile(path: string): void
  removeEmptyDirectory(path: string): void
  publishFileAtomic(path: string, content: string): void
  inspectDirectory(path: string): { canonicalRoot: string; identity: string }
}

export interface ProjectProvisioningResult extends ProjectServiceContextResult {
  root: string
  slug: string
  recoveryId: string
  catalogAudit: 'published' | 'pending-repair'
  reservationAudit: 'released' | 'pending-repair'
}

export interface ProjectRegistrationResult extends ProjectServiceContextResult {
  root: string
  slug: string
  catalogAudit: 'published' | 'pending-repair'
  rootAudit: 'stable'
}

export interface ProjectProvisioner {
  createProject(input: ProjectRegistryV2Owner & {
    name: string
    slug?: string
  }): Promise<ProjectProvisioningResult>
  cloneProject(input: ProjectRegistryV2Owner & {
    name: string
    slug?: string
    url: string
    signal?: AbortSignal
  }): Promise<ProjectProvisioningResult>
  registerProject(input: ProjectRegistryV2Owner & {
    name: string
    slug?: string
    root: string
  }): Promise<ProjectRegistrationResult>
}

export interface RestrictedProjectCloneTransport {
  clone(input: {
    target: RestrictedCloneTarget
    stagingRoot: string
    signal?: AbortSignal
  }): Promise<void>
}

export class ProjectProvisioningError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_PROJECT_NAME'
      | 'INVALID_PROJECT_SLUG'
      | 'PROJECT_ROOT_RESERVED'
      | 'PROJECT_ROOT_EXISTS'
      | 'STAGING_COLLISION'
      | 'PROJECT_CREATE_FAILED'
      | 'PROJECT_CLONE_DISABLED'
      | 'PROJECT_CLONE_FAILED'
      | 'PROJECT_REGISTER_FAILED'
      | 'INVALID_PROJECT_ROOT'
      | 'PROJECT_ROOT_CHANGED'
      | 'PROJECT_QUARANTINE_FAILED'
      | 'PROJECT_PUBLISHED_RUNTIME_RECOVERY_REQUIRED',
    public readonly recoveryId?: string,
  ) {
    super(recoveryId === undefined ? code : `${code}:${recoveryId}`)
    this.name = 'ProjectProvisioningError'
  }
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const CONTROL = /[\u0000-\u001f\u007f]/
const CONTROL_GLOBAL = /[\u0000-\u001f\u007f]/g

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cleanName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length === 0 || name.length > 120 || CONTROL.test(name)) {
    throw new ProjectProvisioningError('INVALID_PROJECT_NAME')
  }
  return name
}

function derivedSlug(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const shortened = ascii.slice(0, 63).replace(/-+$/g, '')
  return SLUG.test(shortened) ? shortened : `project-${hash(name).slice(0, 12)}`
}

function cleanSlug(name: string, requested?: string): string {
  if (requested === undefined) return derivedSlug(name)
  const slug = requested.trim().toLocaleLowerCase('en-US')
  if (slug !== requested || !SLUG.test(slug)) {
    throw new ProjectProvisioningError('INVALID_PROJECT_SLUG')
  }
  return slug
}

function cleanExistingRoot(value: string): string {
  if (!isAbsolute(value)) throw new ProjectProvisioningError('INVALID_PROJECT_ROOT')
  const root = resolve(value)
  if (root === parse(root).root) throw new ProjectProvisioningError('INVALID_PROJECT_ROOT')
  return root
}

function markdown(value: string): string {
  return value.replace(CONTROL_GLOBAL, '�').replace(/\|/g, '\\|')
}

export function renderProjectsCatalog(contexts: ProjectRecordV2[]): string {
  const ordered = [...contexts].sort((left, right) => {
    const leftRank = left.kind === 'workspace' ? 0 : left.archivedAt === undefined ? 1 : 2
    const rightRank = right.kind === 'workspace' ? 0 : right.archivedAt === undefined ? 1 : 2
    return leftRank - rightRank || left.name.localeCompare(right.name, 'ru') || left.id.localeCompare(right.id)
  })
  const rows = ordered.map((item) => [
    markdown(item.name),
    item.kind === 'workspace' ? 'Workspace' : 'Project',
    item.archivedAt === undefined ? 'активен' : 'архив',
    markdown(item.slug ?? '—'),
    markdown(item.id),
  ].join(' | '))
  return [
    '# Проекты Aisy',
    '',
    '> Этот файл сгенерирован из реестра. Ручное изменение не создаёт и не переключает проекты.',
    '',
    'Название | Тип | Статус | Slug | ID',
    '--- | --- | --- | --- | ---',
    ...rows,
    '',
  ].join('\n')
}

function layoutMetadata(input: { name: string; slug: string; recoveryId: string }): string {
  return JSON.stringify({
    version: 1,
    origin: 'created',
    name: input.name,
    slug: input.slug,
    recoveryId: input.recoveryId,
  }, null, 2) + '\n'
}

function reservationMetadata(input: {
  recoveryId: string
  finalRoot: string
  slug: string
}): string {
  return JSON.stringify({
    version: 1,
    recoveryId: input.recoveryId,
    finalRoot: input.finalRoot,
    slug: input.slug,
  }, null, 2) + '\n'
}

function initializeLayout(input: {
  fs: ProjectProvisioningFs
  stagingRoot: string
  name: string
  slug: string
  recoveryId: string
}): void {
  const directories = [
    'memory',
    'memory/facts',
    'knowledge',
    'tasks',
    'skills',
  ]
  for (const relative of directories) input.fs.createDirectory(join(input.stagingRoot, relative))
  const files = new Map<string, string>([
    ['.aisy-project.json', layoutMetadata(input)],
    ['.current-task.md', '# Текущая задача\n'],
    ['knowledge/INDEX.md', '# Знания проекта\n'],
  ])
  for (const [relative, content] of files) {
    const path = join(input.stagingRoot, relative)
    input.fs.writeFileExclusive(path, content)
    input.fs.syncFile(path)
  }
  for (const relative of [...directories].reverse()) {
    input.fs.syncDirectory(join(input.stagingRoot, relative))
  }
  input.fs.syncDirectory(input.stagingRoot)
}

export function makeProjectProvisioner(deps: {
  service: ProjectService
  fs: ProjectProvisioningFs
  treeScanner: ConfinementTreeScanner
  projectsRoot: string
  controlRoot: string
  newId: () => string
  clone?: {
    dns: RestrictedCloneDnsPort
    transport: RestrictedProjectCloneTransport
  }
}): ProjectProvisioner {
  const projectsRoot = resolve(deps.projectsRoot)
  const reservationsRoot = resolve(deps.controlRoot, 'project-reservations')

  function identity(input: ProjectRegistryV2Owner & { name: string; slug?: string }) {
    const owner = { operatorId: input.operatorId, profileId: input.profileId }
    const name = cleanName(input.name)
    const slug = cleanSlug(name, input.slug)
    const finalRoot = resolve(projectsRoot, slug)
    if (dirname(finalRoot) !== projectsRoot) {
      throw new ProjectProvisioningError('INVALID_PROJECT_SLUG')
    }
    if (deps.service.listContexts(owner, true).some(
      (item) => item.root === finalRoot || item.slug === slug,
    )) {
      throw new ProjectProvisioningError('PROJECT_ROOT_EXISTS')
    }
    return { owner, name, slug, finalRoot }
  }

  async function provision(input: ReturnType<typeof identity> & {
    origin: 'created' | 'cloned'
    failureCode: 'PROJECT_CREATE_FAILED' | 'PROJECT_CLONE_FAILED'
    prepare(stagingRoot: string, recoveryId: string): Promise<void> | void
  }): Promise<ProjectProvisioningResult> {
    if (deps.service.listContexts(input.owner, true).some(
      (item) => item.root === input.finalRoot || item.slug === input.slug,
    )) {
      throw new ProjectProvisioningError('PROJECT_ROOT_EXISTS')
    }

    const recoveryId = `recovery-${hash(deps.newId()).slice(0, 16)}`
    const reservationPath = join(reservationsRoot, hash(input.finalRoot))
    const stagingRoot = join(projectsRoot, `.aisy-staging-${recoveryId}`)
    const quarantineRoot = join(projectsRoot, `.aisy-quarantine-${recoveryId}`)
    if (!deps.fs.createDirectoryExclusive(reservationPath)) {
      throw new ProjectProvisioningError('PROJECT_ROOT_RESERVED', recoveryId)
    }
    const reservationRecordPath = join(reservationPath, 'reservation.json')
    const releaseReservation = (): void => {
      if (deps.fs.exists(reservationRecordPath)) deps.fs.removeFile(reservationRecordPath)
      deps.fs.removeEmptyDirectory(reservationPath)
      deps.fs.syncDirectory(reservationsRoot)
    }

    let artifact: string | undefined
    let registryPublished = false
    try {
      deps.fs.writeFileExclusive(
        reservationRecordPath,
        reservationMetadata({
          recoveryId,
          finalRoot: input.finalRoot,
          slug: input.slug,
        }),
      )
      deps.fs.syncFile(reservationRecordPath)
      deps.fs.syncDirectory(reservationPath)
      if (deps.fs.exists(input.finalRoot)) {
        throw new ProjectProvisioningError('PROJECT_ROOT_EXISTS', recoveryId)
      }
      if (!deps.fs.createDirectoryExclusive(stagingRoot)) {
        throw new ProjectProvisioningError('STAGING_COLLISION', recoveryId)
      }
      artifact = stagingRoot
      await input.prepare(stagingRoot, recoveryId)
      await deps.treeScanner.scanRoot(stagingRoot)
      if (deps.fs.exists(input.finalRoot)) {
        throw new ProjectProvisioningError('PROJECT_ROOT_EXISTS', recoveryId)
      }
      deps.fs.renameDirectory(stagingRoot, input.finalRoot)
      artifact = input.finalRoot
      deps.fs.syncDirectory(projectsRoot)

      const published = await deps.service.publishPreparedProject({
        ...input.owner,
        name: input.name,
        slug: input.slug,
        root: input.finalRoot,
        origin: input.origin,
      })
      registryPublished = true
      artifact = undefined

      let catalogAudit: ProjectProvisioningResult['catalogAudit'] = 'published'
      try {
        const contexts = deps.service.listContexts(input.owner, true)
        const workspace = contexts.find((item) => item.kind === 'workspace')
        if (workspace === undefined) throw new Error('workspace missing')
        deps.fs.publishFileAtomic(join(workspace.root, 'PROJECTS.md'), renderProjectsCatalog(contexts))
      } catch {
        catalogAudit = 'pending-repair'
      }

      let reservationAudit: ProjectProvisioningResult['reservationAudit'] = 'released'
      try {
        releaseReservation()
      } catch {
        reservationAudit = 'pending-repair'
      }
      return {
        ...published,
        root: input.finalRoot,
        slug: input.slug,
        recoveryId,
        catalogAudit,
        reservationAudit,
      }
    } catch (error) {
      let durable: boolean
      try {
        durable = deps.service.listContexts(input.owner, true).some(
          (item) => item.root === input.finalRoot,
        )
      } catch {
        // Registry visibility is unknown. Keep both artifact and reservation
        // intact so doctor can reconcile without orphaning an authoritative root.
        throw new ProjectProvisioningError(
          'PROJECT_PUBLISHED_RUNTIME_RECOVERY_REQUIRED',
          recoveryId,
        )
      }
      if (registryPublished || durable) {
        try {
          releaseReservation()
        } catch {
          // The registry is authoritative; doctor can remove the stale reservation.
        }
        throw new ProjectProvisioningError(
          'PROJECT_PUBLISHED_RUNTIME_RECOVERY_REQUIRED',
          recoveryId,
        )
      }

      if (artifact !== undefined) {
        try {
          deps.fs.renameDirectory(artifact, quarantineRoot)
          deps.fs.syncDirectory(projectsRoot)
          artifact = undefined
        } catch {
          throw new ProjectProvisioningError('PROJECT_QUARANTINE_FAILED', recoveryId)
        }
      }
      try {
        releaseReservation()
      } catch {
        throw new ProjectProvisioningError('PROJECT_QUARANTINE_FAILED', recoveryId)
      }
      if (error instanceof ProjectProvisioningError) throw error
      throw new ProjectProvisioningError(input.failureCode, recoveryId)
    }
  }

  return {
    async createProject(input) {
      const project = identity(input)
      return provision({
        ...project,
        origin: 'created',
        failureCode: 'PROJECT_CREATE_FAILED',
        prepare: (stagingRoot, recoveryId) => initializeLayout({
          fs: deps.fs,
          stagingRoot,
          name: project.name,
          slug: project.slug,
          recoveryId,
        }),
      })
    },
    async cloneProject(input) {
      const cloneRuntime = deps.clone
      if (cloneRuntime === undefined) {
        throw new ProjectProvisioningError('PROJECT_CLONE_DISABLED')
      }
      const project = identity(input)
      const target = await resolveRestrictedCloneTarget({
        url: input.url,
        dns: cloneRuntime.dns,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      return provision({
        ...project,
        origin: 'cloned',
        failureCode: 'PROJECT_CLONE_FAILED',
        prepare: (stagingRoot) => cloneRuntime.transport.clone({
          target,
          stagingRoot,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      })
    },
    async registerProject(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const name = cleanName(input.name)
      const slug = cleanSlug(name, input.slug)
      const requestedRoot = cleanExistingRoot(input.root)
      let before: ReturnType<ProjectProvisioningFs['inspectDirectory']>
      try {
        before = deps.fs.inspectDirectory(requestedRoot)
      } catch {
        throw new ProjectProvisioningError('INVALID_PROJECT_ROOT')
      }
      if (before.canonicalRoot !== requestedRoot || before.identity.trim().length === 0) {
        throw new ProjectProvisioningError('INVALID_PROJECT_ROOT')
      }
      const collides = () => deps.service.listContexts(owner, true).some(
        (item) => item.root === requestedRoot || item.slug === slug,
      )
      if (collides()) throw new ProjectProvisioningError('PROJECT_ROOT_EXISTS')
      try {
        await deps.treeScanner.scanRoot(requestedRoot)
      } catch {
        throw new ProjectProvisioningError('PROJECT_REGISTER_FAILED')
      }
      let after: ReturnType<ProjectProvisioningFs['inspectDirectory']>
      try {
        after = deps.fs.inspectDirectory(requestedRoot)
      } catch {
        throw new ProjectProvisioningError('PROJECT_ROOT_CHANGED')
      }
      if (after.canonicalRoot !== before.canonicalRoot || after.identity !== before.identity) {
        throw new ProjectProvisioningError('PROJECT_ROOT_CHANGED')
      }
      if (collides()) throw new ProjectProvisioningError('PROJECT_ROOT_EXISTS')

      let published: ProjectServiceContextResult
      try {
        published = await deps.service.publishPreparedProject({
          ...owner,
          name,
          slug,
          root: requestedRoot,
          origin: 'registered',
        })
      } catch {
        try {
          if (deps.service.listContexts(owner, true).some((item) => item.root === requestedRoot)) {
            throw new ProjectProvisioningError('PROJECT_PUBLISHED_RUNTIME_RECOVERY_REQUIRED')
          }
        } catch (error) {
          if (error instanceof ProjectProvisioningError) throw error
          throw new ProjectProvisioningError('PROJECT_PUBLISHED_RUNTIME_RECOVERY_REQUIRED')
        }
        throw new ProjectProvisioningError('PROJECT_REGISTER_FAILED')
      }

      let catalogAudit: ProjectRegistrationResult['catalogAudit'] = 'published'
      try {
        const contexts = deps.service.listContexts(owner, true)
        const workspace = contexts.find((item) => item.kind === 'workspace')
        if (workspace === undefined) throw new Error('workspace missing')
        deps.fs.publishFileAtomic(join(workspace.root, 'PROJECTS.md'), renderProjectsCatalog(contexts))
      } catch {
        catalogAudit = 'pending-repair'
      }
      return {
        ...published,
        root: requestedRoot,
        slug,
        catalogAudit,
        rootAudit: 'stable',
      }
    },
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function ensureTrustedDirectory(path: string): void {
  const canonical = resolve(path)
  let ancestor = canonical
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new ProjectProvisioningError('PROJECT_CREATE_FAILED')
    ancestor = parent
  }
  const ancestorStat = lstatSync(ancestor)
  if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink() || realpathSync(ancestor) !== ancestor) {
    throw new ProjectProvisioningError('PROJECT_CREATE_FAILED')
  }
  mkdirSync(canonical, { recursive: true, mode: 0o700 })
  const finalStat = lstatSync(canonical)
  if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || realpathSync(canonical) !== canonical) {
    throw new ProjectProvisioningError('PROJECT_CREATE_FAILED')
  }
}

export function makeNodeProjectProvisioner(input: {
  service: ProjectService
  treeScanner: ConfinementTreeScanner
  projectsRoot: string
  controlRoot: string
  newId: () => string
  clone?: {
    dns: RestrictedCloneDnsPort
    transport: RestrictedProjectCloneTransport
  }
}): ProjectProvisioner {
  const projectsRoot = resolve(input.projectsRoot)
  const reservationsRoot = resolve(input.controlRoot, 'project-reservations')
  ensureTrustedDirectory(projectsRoot)
  ensureTrustedDirectory(reservationsRoot)
  const fs: ProjectProvisioningFs = {
    exists: (path) => existsSync(path),
    createDirectoryExclusive: (path) => {
      try {
        mkdirSync(path, { mode: 0o700 })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    },
    createDirectory: (path) => { mkdirSync(path, { mode: 0o700 }) },
    writeFileExclusive: (path, content) => writeFileSync(path, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    }),
    syncFile: syncPath,
    syncDirectory: syncPath,
    renameDirectory: (from, to) => renameSync(from, to),
    removeFile: (path) => unlinkSync(path),
    removeEmptyDirectory: (path) => rmdirSync(path),
    publishFileAtomic: (path, content) => {
      const tempPath = path + '.aisy.tmp'
      writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(tempPath)
      renameSync(tempPath, path)
      syncPath(dirname(path))
    },
    inspectDirectory: (path) => {
      const canonicalRoot = resolve(path)
      const stat = lstatSync(canonicalRoot, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(canonicalRoot) !== canonicalRoot) {
        throw new ProjectProvisioningError('INVALID_PROJECT_ROOT')
      }
      return {
        canonicalRoot,
        identity: `${stat.dev.toString()}:${stat.ino.toString()}`,
      }
    },
  }
  return makeProjectProvisioner({
    service: input.service,
    fs,
    treeScanner: input.treeScanner,
    projectsRoot,
    controlRoot: input.controlRoot,
    newId: input.newId,
    ...(input.clone === undefined ? {} : { clone: input.clone }),
  })
}

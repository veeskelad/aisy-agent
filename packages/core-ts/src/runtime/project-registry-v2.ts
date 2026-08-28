import { createHash } from 'node:crypto'
import { dirname, isAbsolute, normalize, parse, resolve, sep } from 'node:path'
import {
  makeProjectRegistry,
  type ProjectRegistryState,
  type ProjectSessionRecord,
} from './project-registry.js'

export type WorkContextKind = 'workspace' | 'project'
export type ProjectOrigin = 'workspace' | 'created' | 'cloned' | 'registered' | 'legacy'

export interface ProjectRecordV2 {
  id: string
  operatorId: string
  profileId: string
  kind: WorkContextKind
  origin: ProjectOrigin
  name: string
  slug?: string
  root: string
  createdAt: string
  archivedAt?: string
}

export interface ProjectSelectionV2 {
  operatorId: string
  profileId: string
  projectId: string
  sessionId: string
  generation: number
}

export interface ProjectRegistryStateV2 {
  version: 2
  projects: ProjectRecordV2[]
  sessions: ProjectSessionRecord[]
  selections: ProjectSelectionV2[]
}

export interface ProjectRegistryV2Policy {
  homeRoot: string
  projectsRoot: string
  protectedRoots: string[]
}

export interface LegacyRegistryOwner {
  operatorId: string
  profileId: string
  workspaceRoot: string
  workspaceName?: string
}

export interface ProjectRegistryMigrationEquivalence {
  legacyProjects: number
  legacySessions: number
  preservedSelections: number
  workspacesCreated: number
}

export interface WorkspaceRegistryMigrationPlan {
  source: ProjectRegistryState
  candidate: ProjectRegistryStateV2
  backupBytes: string
  candidateBytes: string
  manifest: WorkspaceMigrationManifest
  equivalence: ProjectRegistryMigrationEquivalence
}

export type WorkspaceMigrationPhase =
  | 'PREPARED'
  | 'COPIED'
  | 'VERIFIED'
  | 'COMMITTED'
  | 'V2_WRITES_ENABLED'

export type WorkspaceRegistryStartupMode = 'v1-live' | 'maintenance' | 'v2-live'

export interface WorkspaceMigrationArtifact {
  path: string
  sha256: string
}

export interface WorkspaceMigrationManifest {
  version: 1
  migrationId: string
  phase: WorkspaceMigrationPhase
  sourceRegistrySha256: string
  createdArtifacts: WorkspaceMigrationArtifact[]
  backups: WorkspaceMigrationArtifact[]
  updatedAt: string
}

export interface WorkspaceMigrationManifestPersistencePort {
  load(): WorkspaceMigrationManifest
  saveAtomic(manifest: WorkspaceMigrationManifest): void
}

export interface WorkspaceMigrationCoordinator {
  current(): WorkspaceMigrationManifest
  advance(
    expectedPhase: WorkspaceMigrationPhase,
    nextPhase: WorkspaceMigrationPhase,
  ): WorkspaceMigrationManifest
  recoveryMode(): 'rollback-or-resume' | 'forward-repair'
}

export class ProjectRegistryV2Error extends Error {
  constructor(
    public readonly code:
      | 'CORRUPT_STATE'
      | 'INVALID_POLICY'
      | 'MISSING_OWNER_CONFIGURATION'
      | 'DUPLICATE_ID'
      | 'INVALID_MIGRATION_TRANSITION'
      | 'STALE_MIGRATION_PHASE'
      | 'CORRUPT_MANIFEST'
      | 'PROJECT_NOT_FOUND'
      | 'PROJECT_ARCHIVED'
      | 'PROJECT_NOT_ARCHIVED'
      | 'SESSION_NOT_FOUND'
      | 'SESSION_ARCHIVED'
      | 'SESSION_PROJECT_MISMATCH'
      | 'WORKSPACE_IMMUTABLE'
      | 'INVALID_ORIGIN'
      | 'INVALID_NAME'
      | 'MIGRATION_EQUIVALENCE_FAILED'
      | 'STALE_GENERATION',
  ) {
    super(code)
    this.name = 'ProjectRegistryV2Error'
  }
}

const CONTEXT_KINDS = new Set<WorkContextKind>(['workspace', 'project'])
const PROJECT_ORIGINS = new Set<ProjectOrigin>([
  'workspace',
  'created',
  'cloned',
  'registered',
  'legacy',
])
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MIGRATION_PHASES = new Set<WorkspaceMigrationPhase>([
  'PREPARED',
  'COPIED',
  'VERIFIED',
  'COMMITTED',
  'V2_WRITES_ENABLED',
])

function cloneState(state: ProjectRegistryStateV2): ProjectRegistryStateV2 {
  return {
    version: 2,
    projects: state.projects.map((item) => ({ ...item })),
    sessions: state.sessions.map((item) => ({ ...item })),
    selections: state.selections.map((item) => ({ ...item })),
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function ownerKey(operatorId: string, profileId: string): string {
  return `${operatorId}\u0000${profileId}`
}

function canonicalRoot(value: string): string {
  if (!isAbsolute(value)) throw new ProjectRegistryV2Error('CORRUPT_STATE')
  const root = normalize(resolve(value))
  if (root === parse(root).root) throw new ProjectRegistryV2Error('CORRUPT_STATE')
  return root
}

function canonicalPolicyRoot(value: string): string {
  try {
    return canonicalRoot(value)
  } catch {
    throw new ProjectRegistryV2Error('INVALID_POLICY')
  }
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
}

function validatePolicy(policy: ProjectRegistryV2Policy): ProjectRegistryV2Policy {
  if (!Array.isArray(policy.protectedRoots)) throw new ProjectRegistryV2Error('INVALID_POLICY')
  const homeRoot = canonicalPolicyRoot(policy.homeRoot)
  const projectsRoot = canonicalPolicyRoot(policy.projectsRoot)
  const protectedRoots = policy.protectedRoots.map(canonicalPolicyRoot)
  if (!projectsRoot.startsWith(homeRoot + sep)) throw new ProjectRegistryV2Error('INVALID_POLICY')
  return { homeRoot, projectsRoot, protectedRoots }
}

function validateContextRoot(root: string, policy: ProjectRegistryV2Policy): string {
  const canonical = canonicalRoot(root)
  if (canonical === policy.homeRoot || policy.homeRoot.startsWith(canonical + sep)) {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }
  if (policy.protectedRoots.some((item) => overlaps(canonical, item))) {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }
  return canonical
}

function validateTimestamp(value: unknown): void {
  if (!nonEmpty(value)) throw new ProjectRegistryV2Error('CORRUPT_STATE')
}

/**
 * Validates all durable v2 invariants and returns a defensive, normalized copy.
 * The validator performs no filesystem access; descriptor-relative checks live
 * at the I/O boundary and cannot be replaced by this lexical validation.
 */
export function validateProjectRegistryStateV2(
  input: ProjectRegistryStateV2,
  rawPolicy: ProjectRegistryV2Policy,
): ProjectRegistryStateV2 {
  const policy = validatePolicy(rawPolicy)
  if (typeof input !== 'object' || input === null || input.version !== 2 ||
    !Array.isArray(input.projects) || !Array.isArray(input.sessions) ||
    !Array.isArray(input.selections)) {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }

  const state = cloneState(input)
  const ids = new Set<string>()
  const projectById = new Map<string, ProjectRecordV2>()
  const ownerKeys = new Set<string>()
  const workspaceCount = new Map<string, number>()

  for (const item of state.projects) {
    if (typeof item !== 'object' || item === null ||
      !nonEmpty(item.id) || !nonEmpty(item.operatorId) || !nonEmpty(item.profileId) ||
      !nonEmpty(item.name) || !nonEmpty(item.createdAt) ||
      !CONTEXT_KINDS.has(item.kind) || !PROJECT_ORIGINS.has(item.origin) ||
      (item.archivedAt !== undefined && !nonEmpty(item.archivedAt)) ||
      (item.slug !== undefined && !SLUG_PATTERN.test(item.slug))) {
      throw new ProjectRegistryV2Error('CORRUPT_STATE')
    }
    if (ids.has(item.id)) throw new ProjectRegistryV2Error('CORRUPT_STATE')
    ids.add(item.id)
    item.root = validateContextRoot(item.root, policy)
    validateTimestamp(item.createdAt)

    const key = ownerKey(item.operatorId, item.profileId)
    ownerKeys.add(key)
    if (item.kind === 'workspace') {
      if (item.origin !== 'workspace' || item.archivedAt !== undefined || item.slug !== undefined) {
        throw new ProjectRegistryV2Error('CORRUPT_STATE')
      }
      workspaceCount.set(key, (workspaceCount.get(key) ?? 0) + 1)
    } else {
      if (item.origin === 'workspace') throw new ProjectRegistryV2Error('CORRUPT_STATE')
      if ((item.origin === 'created' || item.origin === 'cloned') &&
        (item.slug === undefined || dirname(item.root) !== policy.projectsRoot)) {
        throw new ProjectRegistryV2Error('CORRUPT_STATE')
      }
    }
    projectById.set(item.id, item)
  }

  for (const key of ownerKeys) {
    if (workspaceCount.get(key) !== 1) throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }

  const activeProjects = state.projects.filter((item) => item.archivedAt === undefined)
  for (let left = 0; left < activeProjects.length; left++) {
    for (let right = left + 1; right < activeProjects.length; right++) {
      if (overlaps(activeProjects[left]!.root, activeProjects[right]!.root)) {
        throw new ProjectRegistryV2Error('CORRUPT_STATE')
      }
    }
  }

  const sessionById = new Map<string, ProjectSessionRecord>()
  const sessionCreateKeys = new Set<string>()
  for (const item of state.sessions) {
    if (typeof item !== 'object' || item === null ||
      !nonEmpty(item.id) || !nonEmpty(item.projectId) || !nonEmpty(item.name) ||
      (item.status !== 'active' && item.status !== 'archived') ||
      !nonEmpty(item.createdAt) || !nonEmpty(item.updatedAt) ||
      ids.has(item.id) || !projectById.has(item.projectId) ||
      (item.createKeyHash !== undefined && !SHA256_PATTERN.test(item.createKeyHash)) ||
      (item.createKeyHash !== undefined && sessionCreateKeys.has(item.createKeyHash))) {
      throw new ProjectRegistryV2Error('CORRUPT_STATE')
    }
    if (item.createKeyHash !== undefined) sessionCreateKeys.add(item.createKeyHash)
    ids.add(item.id)
    sessionById.set(item.id, item)
  }

  const selectionOwners = new Set<string>()
  for (const item of state.selections) {
    if (typeof item !== 'object' || item === null ||
      !nonEmpty(item.operatorId) || !nonEmpty(item.profileId) ||
      !nonEmpty(item.projectId) || !nonEmpty(item.sessionId) ||
      !Number.isSafeInteger(item.generation) || item.generation < 1) {
      throw new ProjectRegistryV2Error('CORRUPT_STATE')
    }
    const key = ownerKey(item.operatorId, item.profileId)
    if (selectionOwners.has(key)) throw new ProjectRegistryV2Error('CORRUPT_STATE')
    selectionOwners.add(key)

    const project = projectById.get(item.projectId)
    const session = sessionById.get(item.sessionId)
    if (!project || project.archivedAt !== undefined ||
      project.operatorId !== item.operatorId || project.profileId !== item.profileId ||
      !session || session.projectId !== project.id || session.status !== 'active') {
      throw new ProjectRegistryV2Error('CORRUPT_STATE')
    }
  }

  for (const key of ownerKeys) {
    if (!selectionOwners.has(key)) throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }
  return state
}

function allocateId(newId: () => string, ids: Set<string>): string {
  const id = newId().trim()
  if (id.length === 0) throw new ProjectRegistryV2Error('CORRUPT_STATE')
  if (ids.has(id)) throw new ProjectRegistryV2Error('DUPLICATE_ID')
  ids.add(id)
  return id
}

export function makeFreshProjectRegistryV2(input: {
  operatorId: string
  profileId: string
  workspaceRoot: string
  nowIso: () => string
  newId: () => string
  policy: ProjectRegistryV2Policy
  workspaceName?: string
}): ProjectRegistryStateV2 {
  if (!nonEmpty(input.operatorId) || !nonEmpty(input.profileId)) {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }
  const ids = new Set<string>()
  const projectId = allocateId(input.newId, ids)
  const sessionId = allocateId(input.newId, ids)
  const now = input.nowIso()
  const state: ProjectRegistryStateV2 = {
    version: 2,
    projects: [{
      id: projectId,
      operatorId: input.operatorId.trim(),
      profileId: input.profileId.trim(),
      kind: 'workspace',
      origin: 'workspace',
      name: input.workspaceName?.trim() || 'Workspace',
      root: input.workspaceRoot,
      createdAt: now,
    }],
    sessions: [{
      id: sessionId,
      projectId,
      name: 'Workspace session',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }],
    selections: [{
      operatorId: input.operatorId.trim(),
      profileId: input.profileId.trim(),
      projectId,
      sessionId,
      generation: 1,
    }],
  }
  return validateProjectRegistryStateV2(state, input.policy)
}

function safeLegacySlug(name: string, id: string, used: Set<string>): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const fallback = `legacy-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
  let candidate = (normalized || fallback).slice(0, 63).replace(/-+$/g, '')
  if (!SLUG_PATTERN.test(candidate)) candidate = fallback
  if (used.has(candidate)) {
    const suffix = createHash('sha256').update(id).digest('hex').slice(0, 8)
    candidate = `${candidate.slice(0, 54).replace(/-+$/g, '')}-${suffix}`
  }
  used.add(candidate)
  return candidate
}

/**
 * Produces a fully validated v2 candidate without publishing it. Existing v1
 * contexts remain legacy Projects; a separate Workspace is created for every
 * explicitly configured owner. The caller owns locking, backups and cutover.
 */
export function migrateProjectRegistryV1(input: {
  state: ProjectRegistryState
  owners: LegacyRegistryOwner[]
  nowIso: () => string
  newId: () => string
  policy: ProjectRegistryV2Policy
}): ProjectRegistryStateV2 {
  let validatedV1: ProjectRegistryState
  try {
    validatedV1 = makeProjectRegistry({
      persistence: { load: () => input.state, save: () => {} },
      nowIso: input.nowIso,
      newId: input.newId,
    }).snapshot()
  } catch {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }

  if (!Array.isArray(input.owners) || input.owners.length === 0) {
    throw new ProjectRegistryV2Error('MISSING_OWNER_CONFIGURATION')
  }
  const owners = new Map<string, LegacyRegistryOwner>()
  for (const owner of input.owners) {
    if (!nonEmpty(owner.operatorId) || !nonEmpty(owner.profileId) || !nonEmpty(owner.workspaceRoot)) {
      throw new ProjectRegistryV2Error('MISSING_OWNER_CONFIGURATION')
    }
    const key = ownerKey(owner.operatorId.trim(), owner.profileId.trim())
    if (owners.has(key)) throw new ProjectRegistryV2Error('MISSING_OWNER_CONFIGURATION')
    owners.set(key, {
      ...owner,
      operatorId: owner.operatorId.trim(),
      profileId: owner.profileId.trim(),
    })
  }

  const ids = new Set<string>()
  for (const project of validatedV1.projects) ids.add(project.id)
  for (const session of validatedV1.sessions) ids.add(session.id)
  const usedSlugs = new Map<string, Set<string>>()
  const projects: ProjectRecordV2[] = validatedV1.projects.map((item) => {
    const key = ownerKey(item.operatorId, item.profileId)
    if (!owners.has(key)) throw new ProjectRegistryV2Error('MISSING_OWNER_CONFIGURATION')
    const slugs = usedSlugs.get(key) ?? new Set<string>()
    usedSlugs.set(key, slugs)
    return {
      id: item.id,
      operatorId: item.operatorId,
      profileId: item.profileId,
      kind: 'project',
      origin: 'legacy',
      name: item.name,
      slug: safeLegacySlug(item.name, item.id, slugs),
      root: item.root,
      createdAt: item.createdAt,
      ...(item.archivedAt === undefined ? {} : { archivedAt: item.archivedAt }),
    }
  })
  const sessions = validatedV1.sessions.map((item) => ({ ...item }))
  const selections: ProjectSelectionV2[] = validatedV1.selections.map((item) => ({
    ...item,
    generation: 1,
  }))
  const selectedOwners = new Set(selections.map((item) => ownerKey(item.operatorId, item.profileId)))
  const now = input.nowIso()

  for (const [key, owner] of owners) {
    const workspaceId = allocateId(input.newId, ids)
    const workspaceSessionId = allocateId(input.newId, ids)
    projects.push({
      id: workspaceId,
      operatorId: owner.operatorId,
      profileId: owner.profileId,
      kind: 'workspace',
      origin: 'workspace',
      name: owner.workspaceName?.trim() || 'Workspace',
      root: owner.workspaceRoot,
      createdAt: now,
    })
    sessions.push({
      id: workspaceSessionId,
      projectId: workspaceId,
      name: 'Workspace session',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    if (!selectedOwners.has(key)) {
      selections.push({
        operatorId: owner.operatorId,
        profileId: owner.profileId,
        projectId: workspaceId,
        sessionId: workspaceSessionId,
        generation: 1,
      })
    }
  }

  return validateProjectRegistryStateV2({ version: 2, projects, sessions, selections }, input.policy)
}

function sameLegacySession(left: ProjectSessionRecord, right: ProjectSessionRecord): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.name === right.name &&
    left.status === right.status && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt
}

/**
 * Proves that a candidate contains the complete v1 registry plus exactly one
 * new Workspace/session per configured owner. This verifier is intentionally
 * independent from the migration planner so a shared implementation bug cannot
 * silently bless missing or modified legacy rows.
 */
export function verifyProjectRegistryV1Migration(input: {
  source: ProjectRegistryState
  candidate: ProjectRegistryStateV2
  owners: LegacyRegistryOwner[]
  policy: ProjectRegistryV2Policy
}): ProjectRegistryMigrationEquivalence {
  let source: ProjectRegistryState
  try {
    source = makeProjectRegistry({
      persistence: { load: () => input.source, save: () => {} },
      nowIso: () => '',
      newId: () => '__equivalence_verifier_must_not_allocate__',
    }).snapshot()
  } catch {
    throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
  }

  let candidate: ProjectRegistryStateV2
  try {
    candidate = validateProjectRegistryStateV2(input.candidate, input.policy)
  } catch {
    throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
  }

  const owners = new Map<string, LegacyRegistryOwner>()
  for (const owner of input.owners) {
    if (!nonEmpty(owner.operatorId) || !nonEmpty(owner.profileId) || !nonEmpty(owner.workspaceRoot)) {
      throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
    }
    const key = ownerKey(owner.operatorId.trim(), owner.profileId.trim())
    if (owners.has(key)) throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
    owners.set(key, owner)
  }

  if (candidate.projects.length !== source.projects.length + owners.size ||
    candidate.sessions.length !== source.sessions.length + owners.size ||
    candidate.selections.length !== owners.size) {
    throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
  }

  for (const legacy of source.projects) {
    const migrated = candidate.projects.find((item) => item.id === legacy.id)
    if (!migrated || migrated.kind !== 'project' || migrated.origin !== 'legacy' ||
      migrated.operatorId !== legacy.operatorId || migrated.profileId !== legacy.profileId ||
      migrated.name !== legacy.name || migrated.root !== legacy.root ||
      migrated.createdAt !== legacy.createdAt || migrated.archivedAt !== legacy.archivedAt) {
      throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
    }
  }

  for (const legacy of source.sessions) {
    const migrated = candidate.sessions.find((item) => item.id === legacy.id)
    if (!migrated || !sameLegacySession(legacy, migrated)) {
      throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
    }
  }

  for (const legacy of source.selections) {
    const migrated = candidate.selections.find(
      (item) => item.operatorId === legacy.operatorId && item.profileId === legacy.profileId,
    )
    if (!migrated || migrated.projectId !== legacy.projectId ||
      migrated.sessionId !== legacy.sessionId || migrated.generation !== 1) {
      throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
    }
  }

  for (const [key, owner] of owners) {
    const workspace = candidate.projects.filter(
      (item) => ownerKey(item.operatorId, item.profileId) === key && item.kind === 'workspace',
    )
    if (workspace.length !== 1 || workspace[0]!.origin !== 'workspace' ||
      workspace[0]!.root !== normalize(resolve(owner.workspaceRoot))) {
      throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
    }
    const workspaceSessions = candidate.sessions.filter((item) => item.projectId === workspace[0]!.id)
    if (workspaceSessions.length !== 1 || workspaceSessions[0]!.status !== 'active') {
      throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
    }
    const legacySelection = source.selections.some(
      (item) => ownerKey(item.operatorId, item.profileId) === key,
    )
    if (!legacySelection) {
      const selected = candidate.selections.find(
        (item) => ownerKey(item.operatorId, item.profileId) === key,
      )
      if (!selected || selected.projectId !== workspace[0]!.id ||
        selected.sessionId !== workspaceSessions[0]!.id || selected.generation !== 1) {
        throw new ProjectRegistryV2Error('MIGRATION_EQUIVALENCE_FAILED')
      }
    }
  }

  return {
    legacyProjects: source.projects.length,
    legacySessions: source.sessions.length,
    preservedSelections: source.selections.length,
    workspacesCreated: owners.size,
  }
}

/**
 * Builds the immutable registry-only migration bundle. It does not write or
 * publish anything: the app layer must first acquire the exclusive migration
 * lock, durably persist this PREPARED manifest, then create the listed files.
 */
export function planWorkspaceRegistryV1Migration(input: {
  sourceBytes: string
  owners: LegacyRegistryOwner[]
  policy: ProjectRegistryV2Policy
  stagingRoot: string
  migrationId: string
  nowIso: () => string
  newId: () => string
}): WorkspaceRegistryMigrationPlan {
  if (!nonEmpty(input.sourceBytes) || !nonEmpty(input.migrationId)) {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }
  let source: ProjectRegistryState
  try {
    source = JSON.parse(input.sourceBytes) as ProjectRegistryState
  } catch {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }
  const candidate = migrateProjectRegistryV1({
    state: source,
    owners: input.owners,
    policy: input.policy,
    nowIso: input.nowIso,
    newId: input.newId,
  })
  const equivalence = verifyProjectRegistryV1Migration({
    source,
    candidate,
    owners: input.owners,
    policy: input.policy,
  })
  const sourceRegistrySha256 = createHash('sha256').update(input.sourceBytes).digest('hex')
  const candidateBytes = JSON.stringify(candidate, null, 2) + '\n'
  const candidateSha256 = createHash('sha256').update(candidateBytes).digest('hex')
  const stagingRoot = canonicalRoot(input.stagingRoot)
  const runDirectory = resolve(
    stagingRoot,
    `run-${createHash('sha256').update(input.migrationId).digest('hex').slice(0, 32)}`,
  )
  const backupPath = resolve(runDirectory, 'projects-v1.backup.json')
  const candidatePath = resolve(runDirectory, 'projects-v2.candidate.json')
  const manifest = validateWorkspaceMigrationManifest({
    version: 1,
    migrationId: input.migrationId,
    phase: 'PREPARED',
    sourceRegistrySha256,
    backups: [{ path: backupPath, sha256: sourceRegistrySha256 }],
    createdArtifacts: [{ path: candidatePath, sha256: candidateSha256 }],
    updatedAt: input.nowIso(),
  })
  return {
    source,
    candidate,
    backupBytes: input.sourceBytes,
    candidateBytes,
    manifest,
    equivalence,
  }
}

const NEXT_PHASE: Partial<Record<WorkspaceMigrationPhase, WorkspaceMigrationPhase>> = {
  PREPARED: 'COPIED',
  COPIED: 'VERIFIED',
  VERIFIED: 'COMMITTED',
  COMMITTED: 'V2_WRITES_ENABLED',
}

function cloneManifest(manifest: WorkspaceMigrationManifest): WorkspaceMigrationManifest {
  return {
    ...manifest,
    createdArtifacts: manifest.createdArtifacts.map((item) => ({ ...item })),
    backups: manifest.backups.map((item) => ({ ...item })),
  }
}

export function validateWorkspaceMigrationManifest(
  manifest: WorkspaceMigrationManifest,
): WorkspaceMigrationManifest {
  if (typeof manifest !== 'object' || manifest === null || manifest.version !== 1 ||
    !nonEmpty(manifest.migrationId) || !MIGRATION_PHASES.has(manifest.phase) ||
    !SHA256_PATTERN.test(manifest.sourceRegistrySha256) ||
    !Array.isArray(manifest.createdArtifacts) || !Array.isArray(manifest.backups) ||
    !nonEmpty(manifest.updatedAt)) {
    throw new ProjectRegistryV2Error('CORRUPT_MANIFEST')
  }
  for (const artifacts of [manifest.createdArtifacts, manifest.backups]) {
    const paths = new Set<string>()
    for (const item of artifacts) {
      if (typeof item !== 'object' || item === null || !nonEmpty(item.path) ||
        !isAbsolute(item.path) || normalize(resolve(item.path)) !== item.path ||
        item.path === parse(item.path).root ||
        !SHA256_PATTERN.test(item.sha256) || paths.has(item.path)) {
        throw new ProjectRegistryV2Error('CORRUPT_MANIFEST')
      }
      paths.add(item.path)
    }
  }
  return cloneManifest(manifest)
}

export function advanceWorkspaceMigration(
  manifest: WorkspaceMigrationManifest,
  expectedPhase: WorkspaceMigrationPhase,
  nextPhase: WorkspaceMigrationPhase,
  updatedAt: string,
): WorkspaceMigrationManifest {
  const current = validateWorkspaceMigrationManifest(manifest)
  if (current.phase !== expectedPhase) {
    throw new ProjectRegistryV2Error('STALE_MIGRATION_PHASE')
  }
  if (NEXT_PHASE[expectedPhase] !== nextPhase) {
    throw new ProjectRegistryV2Error('INVALID_MIGRATION_TRANSITION')
  }
  return {
    ...current,
    phase: nextPhase,
    updatedAt,
  }
}

export function recoveryModeForWorkspaceMigration(
  manifest: WorkspaceMigrationManifest,
): 'rollback-or-resume' | 'forward-repair' {
  const current = validateWorkspaceMigrationManifest(manifest)
  return current.phase === 'V2_WRITES_ENABLED' ? 'forward-repair' : 'rollback-or-resume'
}

export function resolveWorkspaceRegistryStartupMode(
  manifest: WorkspaceMigrationManifest | null,
): WorkspaceRegistryStartupMode {
  if (manifest === null) return 'v1-live'
  const current = validateWorkspaceMigrationManifest(manifest)
  return current.phase === 'V2_WRITES_ENABLED' ? 'v2-live' : 'maintenance'
}

/**
 * Coordinates one already-created migration manifest. In-memory state changes
 * only after the persistence port has atomically published the next phase, so
 * a thrown write leaves both the running coordinator and a restarted process
 * on the previous durable phase.
 */
export function makeWorkspaceMigrationCoordinator(input: {
  persistence: WorkspaceMigrationManifestPersistencePort
  nowIso: () => string
}): WorkspaceMigrationCoordinator {
  let manifest = validateWorkspaceMigrationManifest(input.persistence.load())
  return {
    current() {
      return cloneManifest(manifest)
    },
    advance(expectedPhase, nextPhase) {
      const candidate = advanceWorkspaceMigration(
        manifest,
        expectedPhase,
        nextPhase,
        input.nowIso(),
      )
      input.persistence.saveAtomic(cloneManifest(candidate))
      manifest = candidate
      return cloneManifest(manifest)
    },
    recoveryMode() {
      return recoveryModeForWorkspaceMigration(manifest)
    },
  }
}

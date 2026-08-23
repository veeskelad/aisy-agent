import { isAbsolute, normalize, parse, resolve, sep } from 'node:path'

export type ProjectId = string
export type ProjectSessionId = string

export interface ProjectRecord {
  id: ProjectId
  operatorId: string
  profileId: string
  name: string
  root: string
  isDefault: boolean
  createdAt: string
  archivedAt?: string
}

export interface ProjectSessionRecord {
  id: ProjectSessionId
  projectId: ProjectId
  name: string
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export interface ProjectSelection {
  operatorId: string
  profileId: string
  projectId: ProjectId
  sessionId: ProjectSessionId
}

export interface ProjectRegistryState {
  version: 1
  projects: ProjectRecord[]
  sessions: ProjectSessionRecord[]
  selections: ProjectSelection[]
}

export interface ProjectRegistryPersistencePort {
  load(): ProjectRegistryState | null
  save(state: ProjectRegistryState): void
}

export interface ProjectRegistryEvent {
  kind:
    | 'project.created'
    | 'project.selected'
    | 'session.created'
    | 'session.renamed'
    | 'session.archived'
    | 'session.restored'
  projectId: string
  sessionId?: string
}

export interface ProjectRegistry {
  ensureDefault(input: {
    operatorId: string
    profileId: string
    root: string
    legacySessionId?: string
  }): ProjectSelection
  createProject(input: {
    operatorId: string
    profileId: string
    name: string
    root: string
  }): ProjectRecord
  listProjects(operatorId: string, profileId: string): ProjectRecord[]
  getActive(operatorId: string, profileId: string): ProjectSelection | null
  switchProject(input: {
    operatorId: string
    profileId: string
    projectId: string
    sessionId?: string
  }): ProjectSelection
  createSession(projectId: string, name?: string): ProjectSessionRecord
  renameSession(projectId: string, sessionId: string, name: string): ProjectSessionRecord
  archiveSession(projectId: string, sessionId: string): ProjectSessionRecord
  restoreSession(projectId: string, sessionId: string): ProjectSessionRecord
  searchSessions(projectId: string, query: string, includeArchived?: boolean): ProjectSessionRecord[]
  resolveOwnedPath(projectId: string, sessionId: string, relativePath: string): string
  snapshot(): ProjectRegistryState
}

export class ProjectRegistryError extends Error {
  constructor(
    public readonly code:
      | 'CORRUPT_STATE'
      | 'INVALID_NAME'
      | 'INVALID_ROOT'
      | 'DUPLICATE_ROOT'
      | 'PROJECT_NOT_FOUND'
      | 'PROJECT_ARCHIVED'
      | 'SESSION_NOT_FOUND'
      | 'SESSION_ARCHIVED'
      | 'SESSION_PROJECT_MISMATCH'
      | 'PATH_OUTSIDE_PROJECT',
  ) {
    super(code)
    this.name = 'ProjectRegistryError'
  }
}

function cloneState(state: ProjectRegistryState): ProjectRegistryState {
  return {
    version: 1,
    projects: state.projects.map((item) => ({ ...item })),
    sessions: state.sessions.map((item) => ({ ...item })),
    selections: state.selections.map((item) => ({ ...item })),
  }
}

function validState(value: ProjectRegistryState | null): value is ProjectRegistryState {
  return value !== null &&
    value.version === 1 &&
    Array.isArray(value.projects) &&
    Array.isArray(value.sessions) &&
    Array.isArray(value.selections)
}

function cleanName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length === 0 || name.length > 120) throw new ProjectRegistryError('INVALID_NAME')
  return name
}

function cleanIdentity(value: string): string {
  const result = value.trim()
  if (result.length === 0) throw new ProjectRegistryError('CORRUPT_STATE')
  return result
}

function cleanRoot(value: string): string {
  if (!isAbsolute(value)) throw new ProjectRegistryError('INVALID_ROOT')
  const root = normalize(resolve(value))
  if (root === parse(root).root) throw new ProjectRegistryError('INVALID_ROOT')
  return root
}

function selectionKey(operatorId: string, profileId: string): string {
  return operatorId + '\u0000' + profileId
}

function rootsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
}

export function makeProjectRegistry(deps: {
  persistence?: ProjectRegistryPersistencePort
  nowIso: () => string
  newId: () => string
  emit?: (event: ProjectRegistryEvent) => void
}): ProjectRegistry {
  const loaded = deps.persistence?.load() ?? {
    version: 1 as const,
    projects: [],
    sessions: [],
    selections: [],
  }
  if (!validState(loaded)) throw new ProjectRegistryError('CORRUPT_STATE')
  const state = cloneState(loaded)

  const ids = new Set<string>()
  for (const item of state.projects) {
    if (typeof item !== 'object' || item === null ||
      typeof item.id !== 'string' ||
      typeof item.operatorId !== 'string' ||
      typeof item.profileId !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.root !== 'string' ||
      typeof item.isDefault !== 'boolean' ||
      typeof item.createdAt !== 'string' ||
      ids.has(item.id)) throw new ProjectRegistryError('CORRUPT_STATE')
    ids.add(item.id)
    try { item.root = cleanRoot(item.root) } catch { throw new ProjectRegistryError('CORRUPT_STATE') }
  }
  for (let i = 0; i < state.projects.length; i++) {
    for (let j = i + 1; j < state.projects.length; j++) {
      const a = state.projects[i]!
      const b = state.projects[j]!
      if (!a.archivedAt && !b.archivedAt && rootsOverlap(a.root, b.root)) {
        throw new ProjectRegistryError('CORRUPT_STATE')
      }
    }
  }
  for (const item of state.sessions) {
    if (typeof item !== 'object' || item === null ||
      typeof item.id !== 'string' ||
      typeof item.projectId !== 'string' ||
      typeof item.name !== 'string' ||
      (item.status !== 'active' && item.status !== 'archived') ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string' ||
      ids.has(item.id)) throw new ProjectRegistryError('CORRUPT_STATE')
    ids.add(item.id)
    if (!state.projects.some((project) => project.id === item.projectId)) {
      throw new ProjectRegistryError('CORRUPT_STATE')
    }
  }
  for (const item of state.selections) {
    if (typeof item !== 'object' || item === null ||
      typeof item.operatorId !== 'string' ||
      typeof item.profileId !== 'string' ||
      typeof item.projectId !== 'string' ||
      typeof item.sessionId !== 'string') {
      throw new ProjectRegistryError('CORRUPT_STATE')
    }
    const selectedProject = state.projects.find((project) => project.id === item.projectId)
    const selectedSession = state.sessions.find((session) => session.id === item.sessionId)
    if (!selectedProject || selectedProject.archivedAt ||
      selectedProject.operatorId !== item.operatorId ||
      selectedProject.profileId !== item.profileId ||
      !selectedSession ||
      selectedSession.projectId !== selectedProject.id ||
      selectedSession.status !== 'active') {
      throw new ProjectRegistryError('CORRUPT_STATE')
    }
  }

  const allocateId = (): string => {
    const id = cleanIdentity(deps.newId())
    if (ids.has(id)) throw new ProjectRegistryError('CORRUPT_STATE')
    ids.add(id)
    return id
  }

  const persist = (): void => deps.persistence?.save(cloneState(state))
  const emit = (event: ProjectRegistryEvent): void => deps.emit?.({ ...event })
  const project = (projectId: string): ProjectRecord => {
    const found = state.projects.find((item) => item.id === projectId)
    if (!found) throw new ProjectRegistryError('PROJECT_NOT_FOUND')
    if (found.archivedAt) throw new ProjectRegistryError('PROJECT_ARCHIVED')
    return found
  }
  const session = (projectId: string, sessionId: string, allowArchived = false): ProjectSessionRecord => {
    const found = state.sessions.find((item) => item.id === sessionId)
    if (!found) throw new ProjectRegistryError('SESSION_NOT_FOUND')
    if (found.projectId !== projectId) throw new ProjectRegistryError('SESSION_PROJECT_MISMATCH')
    if (!allowArchived && found.status === 'archived') throw new ProjectRegistryError('SESSION_ARCHIVED')
    return found
  }
  const saveSelection = (next: ProjectSelection): ProjectSelection => {
    const key = selectionKey(next.operatorId, next.profileId)
    const index = state.selections.findIndex(
      (item) => selectionKey(item.operatorId, item.profileId) === key,
    )
    if (index >= 0) state.selections[index] = { ...next }
    else state.selections.push({ ...next })
    persist()
    emit({ kind: 'project.selected', projectId: next.projectId, sessionId: next.sessionId })
    return { ...next }
  }
  const createSession = (projectId: string, name = 'New session', forcedId?: string): ProjectSessionRecord => {
    project(projectId)
    const now = deps.nowIso()
    const record: ProjectSessionRecord = {
      id: forcedId ? cleanIdentity(forcedId) : allocateId(),
      projectId,
      name: cleanName(name),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    if (ids.has(record.id) && forcedId) throw new ProjectRegistryError('CORRUPT_STATE')
    if (forcedId) ids.add(record.id)
    state.sessions.push(record)
    persist()
    emit({ kind: 'session.created', projectId, sessionId: record.id })
    return { ...record }
  }

  return {
    ensureDefault(input) {
      const operatorId = cleanIdentity(input.operatorId)
      const profileId = cleanIdentity(input.profileId)
      const existingSelection = state.selections.find(
        (item) => item.operatorId === operatorId && item.profileId === profileId,
      )
      if (existingSelection) {
        project(existingSelection.projectId)
        session(existingSelection.projectId, existingSelection.sessionId)
        return { ...existingSelection }
      }

      let found = state.projects.find(
        (item) => item.operatorId === operatorId && item.profileId === profileId && item.isDefault,
      )
      if (!found) {
        const root = cleanRoot(input.root)
        if (state.projects.some((item) => !item.archivedAt && rootsOverlap(item.root, root))) {
          throw new ProjectRegistryError('DUPLICATE_ROOT')
        }
        found = {
          id: allocateId(),
          operatorId,
          profileId,
          name: 'Default',
          root,
          isDefault: true,
          createdAt: deps.nowIso(),
        }
        state.projects.push(found)
        persist()
        emit({ kind: 'project.created', projectId: found.id })
      }
      const active = state.sessions
        .filter((item) => item.projectId === found!.id && item.status === 'active')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      const selectedSession = active ?? createSession(
        found.id,
        'Imported session',
        input.legacySessionId,
      )
      return saveSelection({ operatorId, profileId, projectId: found.id, sessionId: selectedSession.id })
    },

    createProject(input) {
      const operatorId = cleanIdentity(input.operatorId)
      const profileId = cleanIdentity(input.profileId)
      const root = cleanRoot(input.root)
      if (state.projects.some(
        (item) => !item.archivedAt && rootsOverlap(item.root, root),
      )) throw new ProjectRegistryError('DUPLICATE_ROOT')
      const record: ProjectRecord = {
        id: allocateId(),
        operatorId,
        profileId,
        name: cleanName(input.name),
        root,
        isDefault: false,
        createdAt: deps.nowIso(),
      }
      state.projects.push(record)
      persist()
      emit({ kind: 'project.created', projectId: record.id })
      return { ...record }
    },

    listProjects(operatorId, profileId) {
      return state.projects
        .filter((item) => item.operatorId === operatorId && item.profileId === profileId && !item.archivedAt)
        .map((item) => ({ ...item }))
    },

    getActive(operatorId, profileId) {
      const found = state.selections.find(
        (item) => item.operatorId === operatorId && item.profileId === profileId,
      )
      return found ? { ...found } : null
    },

    switchProject(input) {
      const found = project(input.projectId)
      if (found.operatorId !== input.operatorId || found.profileId !== input.profileId) {
        throw new ProjectRegistryError('PROJECT_NOT_FOUND')
      }
      let selectedSession: ProjectSessionRecord | undefined
      if (input.sessionId) selectedSession = session(found.id, input.sessionId)
      else {
        selectedSession = state.sessions
          .filter((item) => item.projectId === found.id && item.status === 'active')
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      }
      selectedSession ??= createSession(found.id)
      return saveSelection({
        operatorId: input.operatorId,
        profileId: input.profileId,
        projectId: found.id,
        sessionId: selectedSession.id,
      })
    },

    createSession(projectId, name) {
      return createSession(projectId, name)
    },

    renameSession(projectId, sessionId, name) {
      project(projectId)
      const found = session(projectId, sessionId)
      found.name = cleanName(name)
      found.updatedAt = deps.nowIso()
      persist()
      emit({ kind: 'session.renamed', projectId, sessionId })
      return { ...found }
    },

    archiveSession(projectId, sessionId) {
      project(projectId)
      const found = session(projectId, sessionId)
      found.status = 'archived'
      found.updatedAt = deps.nowIso()
      state.selections = state.selections.filter((item) => item.sessionId !== sessionId)
      persist()
      emit({ kind: 'session.archived', projectId, sessionId })
      return { ...found }
    },

    restoreSession(projectId, sessionId) {
      project(projectId)
      const found = session(projectId, sessionId, true)
      found.status = 'active'
      found.updatedAt = deps.nowIso()
      persist()
      emit({ kind: 'session.restored', projectId, sessionId })
      return { ...found }
    },

    searchSessions(projectId, query, includeArchived = false) {
      project(projectId)
      const needle = query.trim().toLocaleLowerCase()
      return state.sessions
        .filter((item) =>
          item.projectId === projectId &&
          (includeArchived || item.status === 'active') &&
          (needle.length === 0 || item.name.toLocaleLowerCase().includes(needle)),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((item) => ({ ...item }))
    },

    resolveOwnedPath(projectId, sessionId, relativePath) {
      const found = project(projectId)
      session(projectId, sessionId)
      if (relativePath.trim().length === 0 || isAbsolute(relativePath)) {
        throw new ProjectRegistryError('PATH_OUTSIDE_PROJECT')
      }
      const candidate = resolve(found.root, relativePath)
      if (candidate !== found.root && !candidate.startsWith(found.root + sep)) {
        throw new ProjectRegistryError('PATH_OUTSIDE_PROJECT')
      }
      return candidate
    },

    snapshot() {
      return cloneState(state)
    },
  }
}

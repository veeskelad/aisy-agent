import {
  ProjectRegistryV2Error,
  validateProjectRegistryStateV2,
  type ProjectOrigin,
  type ProjectRecordV2,
  type ProjectRegistryStateV2,
  type ProjectRegistryV2Policy,
  type ProjectSelectionV2,
} from './project-registry-v2.js'
import type { ProjectSessionRecord } from './project-registry.js'

export interface ProjectRegistryV2Owner {
  operatorId: string
  profileId: string
}

export interface ProjectRegistryV2Event {
  kind:
    | 'project.created'
    | 'project.archived'
    | 'project.restored'
    | 'context.selected'
    | 'session.created'
    | 'session.renamed'
    | 'session.archived'
    | 'session.restored'
  projectId: string
  sessionId?: string
  generation?: number
}

export interface ProjectRegistryV2PersistencePort {
  saveAtomic(state: ProjectRegistryStateV2): void
}

export interface ProjectRegistryV2 {
  listContexts(owner: ProjectRegistryV2Owner, includeArchived?: boolean): ProjectRecordV2[]
  getActive(owner: ProjectRegistryV2Owner): ProjectSelectionV2
  getSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
  }): ProjectSessionRecord
  createProject(input: ProjectRegistryV2Owner & {
    name: string
    slug?: string
    root: string
    origin: Exclude<ProjectOrigin, 'workspace' | 'legacy'>
    expectedGeneration?: number
  }): ProjectSelectionV2
  switchContext(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId?: string
    expectedGeneration: number
  }): ProjectSelectionV2
  archiveProject(input: ProjectRegistryV2Owner & {
    projectId: string
    expectedGeneration?: number
  }): ProjectRecordV2
  restoreProject(input: ProjectRegistryV2Owner & { projectId: string }): ProjectRecordV2
  createSession(input: ProjectRegistryV2Owner & {
    projectId: string
    name?: string
    expectedGeneration?: number
  }): ProjectSessionRecord
  renameSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
    name: string
    expectedGeneration?: number
  }): ProjectSessionRecord
  archiveSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
    expectedGeneration?: number
  }): ProjectSessionRecord
  restoreSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
  }): ProjectSessionRecord
  searchSessions(input: ProjectRegistryV2Owner & {
    projectId: string
    query: string
    includeArchived?: boolean
  }): ProjectSessionRecord[]
  snapshot(): ProjectRegistryStateV2
}

function cloneState(state: ProjectRegistryStateV2): ProjectRegistryStateV2 {
  return {
    version: 2,
    projects: state.projects.map((item) => ({ ...item })),
    sessions: state.sessions.map((item) => ({ ...item })),
    selections: state.selections.map((item) => ({ ...item })),
  }
}

function cleanName(value: string, fallback?: string): string {
  const name = value.trim().replace(/\s+/g, ' ') || fallback
  if (name === undefined || name.length === 0 || name.length > 120) {
    throw new ProjectRegistryV2Error('INVALID_NAME')
  }
  return name
}

function cleanOwner(owner: ProjectRegistryV2Owner): ProjectRegistryV2Owner {
  const operatorId = owner.operatorId.trim()
  const profileId = owner.profileId.trim()
  if (operatorId.length === 0 || profileId.length === 0) {
    throw new ProjectRegistryV2Error('CORRUPT_STATE')
  }
  return { operatorId, profileId }
}

function sameOwner(record: ProjectRecordV2, owner: ProjectRegistryV2Owner): boolean {
  return record.operatorId === owner.operatorId && record.profileId === owner.profileId
}

export function makeProjectRegistryV2(deps: {
  state: ProjectRegistryStateV2
  policy: ProjectRegistryV2Policy
  nowIso: () => string
  newId: () => string
  persistence?: ProjectRegistryV2PersistencePort
  emit?: (event: ProjectRegistryV2Event) => void
}): ProjectRegistryV2 {
  let state = validateProjectRegistryStateV2(deps.state, deps.policy)

  const project = (
    candidate: ProjectRegistryStateV2,
    owner: ProjectRegistryV2Owner,
    projectId: string,
    allowArchived = false,
  ): ProjectRecordV2 => {
    const found = candidate.projects.find((item) => item.id === projectId)
    if (!found || !sameOwner(found, owner)) throw new ProjectRegistryV2Error('PROJECT_NOT_FOUND')
    if (!allowArchived && found.archivedAt !== undefined) {
      throw new ProjectRegistryV2Error('PROJECT_ARCHIVED')
    }
    return found
  }

  const session = (
    candidate: ProjectRegistryStateV2,
    projectId: string,
    sessionId: string,
    allowArchived = false,
  ): ProjectSessionRecord => {
    const found = candidate.sessions.find((item) => item.id === sessionId)
    if (!found) throw new ProjectRegistryV2Error('SESSION_NOT_FOUND')
    if (found.projectId !== projectId) throw new ProjectRegistryV2Error('SESSION_PROJECT_MISMATCH')
    if (!allowArchived && found.status === 'archived') {
      throw new ProjectRegistryV2Error('SESSION_ARCHIVED')
    }
    return found
  }

  const selection = (
    candidate: ProjectRegistryStateV2,
    owner: ProjectRegistryV2Owner,
  ): ProjectSelectionV2 => {
    const found = candidate.selections.find(
      (item) => item.operatorId === owner.operatorId && item.profileId === owner.profileId,
    )
    if (!found) throw new ProjectRegistryV2Error('CORRUPT_STATE')
    return found
  }

  const allocateId = (candidate: ProjectRegistryStateV2): string => {
    const id = deps.newId().trim()
    if (id.length === 0 || candidate.projects.some((item) => item.id === id) ||
      candidate.sessions.some((item) => item.id === id)) {
      throw new ProjectRegistryV2Error('DUPLICATE_ID')
    }
    return id
  }

  const createSession = (
    candidate: ProjectRegistryStateV2,
    projectId: string,
    name: string | undefined,
  ): ProjectSessionRecord => {
    const now = deps.nowIso()
    const record: ProjectSessionRecord = {
      id: allocateId(candidate),
      projectId,
      name: cleanName(name ?? '', 'New session'),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    candidate.sessions.push(record)
    return record
  }

  const latestActiveSession = (
    candidate: ProjectRegistryStateV2,
    projectId: string,
    excluding?: string,
  ): ProjectSessionRecord | undefined => candidate.sessions
    .filter((item) => item.projectId === projectId && item.status === 'active' && item.id !== excluding)
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    )[0]

  const publish = <T>(
    mutate: (candidate: ProjectRegistryStateV2) => { result: T; events: ProjectRegistryV2Event[] },
  ): T => {
    const candidate = cloneState(state)
    const transition = mutate(candidate)
    const validated = validateProjectRegistryStateV2(candidate, deps.policy)
    deps.persistence?.saveAtomic(cloneState(validated))
    state = validated
    for (const event of transition.events) deps.emit?.({ ...event })
    return transition.result
  }

  return {
    listContexts(rawOwner, includeArchived = false) {
      const owner = cleanOwner(rawOwner)
      return state.projects
        .filter((item) => sameOwner(item, owner) && (includeArchived || item.archivedAt === undefined))
        .map((item) => ({ ...item }))
    },

    getActive(rawOwner) {
      return { ...selection(state, cleanOwner(rawOwner)) }
    },

    getSession(input) {
      const owner = cleanOwner(input)
      project(state, owner, input.projectId)
      return { ...session(state, input.projectId, input.sessionId) }
    },

    createProject(input) {
      const owner = cleanOwner(input)
      if (input.origin !== 'created' && input.origin !== 'cloned' && input.origin !== 'registered') {
        throw new ProjectRegistryV2Error('INVALID_ORIGIN')
      }
      return publish((candidate) => {
        const current = selection(candidate, owner)
        if (input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        const now = deps.nowIso()
        const record: ProjectRecordV2 = {
          id: allocateId(candidate),
          ...owner,
          kind: 'project',
          origin: input.origin,
          name: cleanName(input.name),
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          root: input.root,
          createdAt: now,
        }
        candidate.projects.push(record)
        const createdSession = createSession(candidate, record.id, 'New session')
        const next: ProjectSelectionV2 = {
          ...owner,
          projectId: record.id,
          sessionId: createdSession.id,
          generation: current.generation + 1,
        }
        Object.assign(current, next)
        return {
          result: { ...next },
          events: [
            { kind: 'project.created', projectId: record.id },
            { kind: 'session.created', projectId: record.id, sessionId: createdSession.id },
            {
              kind: 'context.selected',
              projectId: record.id,
              sessionId: createdSession.id,
              generation: next.generation,
            },
          ],
        }
      })
    },

    switchContext(input) {
      const owner = cleanOwner(input)
      return publish((candidate) => {
        const current = selection(candidate, owner)
        if (current.generation !== input.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        const target = project(candidate, owner, input.projectId)
        const events: ProjectRegistryV2Event[] = []
        let targetSession = input.sessionId === undefined
          ? latestActiveSession(candidate, target.id)
          : session(candidate, target.id, input.sessionId)
        if (!targetSession) {
          targetSession = createSession(candidate, target.id, undefined)
          events.push({ kind: 'session.created', projectId: target.id, sessionId: targetSession.id })
        }
        const next: ProjectSelectionV2 = {
          ...owner,
          projectId: target.id,
          sessionId: targetSession.id,
          generation: current.generation + 1,
        }
        Object.assign(current, next)
        events.push({
          kind: 'context.selected',
          projectId: target.id,
          sessionId: targetSession.id,
          generation: next.generation,
        })
        return { result: { ...next }, events }
      })
    },

    archiveProject(input) {
      const owner = cleanOwner(input)
      return publish((candidate) => {
        const current = selection(candidate, owner)
        if (input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        const target = project(candidate, owner, input.projectId, true)
        if (target.kind === 'workspace') throw new ProjectRegistryV2Error('WORKSPACE_IMMUTABLE')
        if (target.archivedAt !== undefined) throw new ProjectRegistryV2Error('PROJECT_ARCHIVED')
        target.archivedAt = deps.nowIso()
        const events: ProjectRegistryV2Event[] = [{ kind: 'project.archived', projectId: target.id }]
        if (current.projectId === target.id) {
          const workspace = candidate.projects.find(
            (item) => sameOwner(item, owner) && item.kind === 'workspace',
          )!
          let targetSession = latestActiveSession(candidate, workspace.id)
          if (!targetSession) {
            targetSession = createSession(candidate, workspace.id, undefined)
            events.push({ kind: 'session.created', projectId: workspace.id, sessionId: targetSession.id })
          }
          Object.assign(current, {
            projectId: workspace.id,
            sessionId: targetSession.id,
            generation: current.generation + 1,
          })
          events.push({
            kind: 'context.selected',
            projectId: workspace.id,
            sessionId: targetSession.id,
            generation: current.generation,
          })
        }
        return { result: { ...target }, events }
      })
    },

    restoreProject(input) {
      const owner = cleanOwner(input)
      return publish((candidate) => {
        const target = project(candidate, owner, input.projectId, true)
        if (target.kind === 'workspace') throw new ProjectRegistryV2Error('WORKSPACE_IMMUTABLE')
        if (target.archivedAt === undefined) throw new ProjectRegistryV2Error('PROJECT_NOT_ARCHIVED')
        delete target.archivedAt
        return {
          result: { ...target },
          events: [{ kind: 'project.restored', projectId: target.id }],
        }
      })
    },

    createSession(input) {
      const owner = cleanOwner(input)
      return publish((candidate) => {
        const current = selection(candidate, owner)
        if (input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        project(candidate, owner, input.projectId)
        const created = createSession(candidate, input.projectId, input.name)
        return {
          result: { ...created },
          events: [{ kind: 'session.created', projectId: input.projectId, sessionId: created.id }],
        }
      })
    },

    renameSession(input) {
      const owner = cleanOwner(input)
      return publish((candidate) => {
        const current = selection(candidate, owner)
        if (input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        project(candidate, owner, input.projectId)
        const target = session(candidate, input.projectId, input.sessionId)
        target.name = cleanName(input.name)
        target.updatedAt = deps.nowIso()
        return {
          result: { ...target },
          events: [{ kind: 'session.renamed', projectId: input.projectId, sessionId: target.id }],
        }
      })
    },

    archiveSession(input) {
      const owner = cleanOwner(input)
      return publish((candidate) => {
        const current = selection(candidate, owner)
        if (input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        project(candidate, owner, input.projectId)
        const target = session(candidate, input.projectId, input.sessionId)
        target.status = 'archived'
        target.updatedAt = deps.nowIso()
        const events: ProjectRegistryV2Event[] = [
          { kind: 'session.archived', projectId: input.projectId, sessionId: target.id },
        ]
        if (current.sessionId === target.id) {
          let replacement = latestActiveSession(candidate, input.projectId, target.id)
          if (!replacement) {
            replacement = createSession(candidate, input.projectId, undefined)
            events.push({ kind: 'session.created', projectId: input.projectId, sessionId: replacement.id })
          }
          current.sessionId = replacement.id
          current.generation++
          events.push({
            kind: 'context.selected',
            projectId: input.projectId,
            sessionId: replacement.id,
            generation: current.generation,
          })
        }
        return { result: { ...target }, events }
      })
    },

    restoreSession(input) {
      const owner = cleanOwner(input)
      return publish((candidate) => {
        project(candidate, owner, input.projectId)
        const target = session(candidate, input.projectId, input.sessionId, true)
        target.status = 'active'
        target.updatedAt = deps.nowIso()
        return {
          result: { ...target },
          events: [{ kind: 'session.restored', projectId: input.projectId, sessionId: target.id }],
        }
      })
    },

    searchSessions(input) {
      const owner = cleanOwner(input)
      const target = project(state, owner, input.projectId)
      const needle = input.query.trim().toLocaleLowerCase()
      return state.sessions
        .filter((item) => item.projectId === target.id &&
          (input.includeArchived || item.status === 'active') &&
          (needle.length === 0 || item.name.toLocaleLowerCase().includes(needle)))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((item) => ({ ...item }))
    },

    snapshot() {
      return cloneState(state)
    },
  }
}

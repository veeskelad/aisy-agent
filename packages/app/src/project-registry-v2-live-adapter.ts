// Live-composition adapter for the v2 project registry.
//
// After the cutover the composition root still needs the small surface it always
// used: an active selection, a snapshot to look records up in, and session
// creation. This adapter exposes exactly that over `ProjectRegistryV2` — it adds
// no capability and hides none of v2's authority checks.
//
// The v1 shape is preserved deliberately: `isDefault` is derived from the v2
// `kind === 'workspace'`, never stored twice.

import type {
  ProjectRecord,
  ProjectRegistryV2,
  ProjectRegistryV2Owner,
  ProjectSelection,
  ProjectSessionRecord,
} from '@aisy/core'

export interface LiveProjectRegistryView {
  ensureDefault(owner: ProjectRegistryV2Owner): ProjectSelection
  snapshot(): { projects: ProjectRecord[]; sessions: ProjectSessionRecord[] }
  createSession(projectId: string, name: string): ProjectSessionRecord
}

function toV1Project(record: {
  id: string
  operatorId: string
  profileId: string
  kind: string
  name: string
  root: string
  createdAt: string
  archivedAt?: string
}): ProjectRecord {
  const base: ProjectRecord = {
    id: record.id,
    operatorId: record.operatorId,
    profileId: record.profileId,
    name: record.name,
    root: record.root,
    isDefault: record.kind === 'workspace',
    createdAt: record.createdAt,
  }
  return record.archivedAt === undefined ? base : { ...base, archivedAt: record.archivedAt }
}

/**
 * Wrap a v2 registry for the live composition root. `owner` is the single
 * operator/profile pair this process runs as; session creation refuses to
 * silently target another owner's project.
 */
export function makeLiveProjectRegistryView(input: {
  registry: ProjectRegistryV2
  owner: ProjectRegistryV2Owner
}): LiveProjectRegistryView {
  const owner: ProjectRegistryV2Owner = Object.freeze({ ...input.owner })

  return {
    ensureDefault(requested: ProjectRegistryV2Owner): ProjectSelection {
      // v2 has no "create a default on read": the migration already published the
      // Workspace context, so an owner without one is a real error, not a prompt
      // to invent state.
      if (requested.operatorId !== owner.operatorId || requested.profileId !== owner.profileId) {
        throw new Error('project registry v2: selection requested for another owner')
      }
      const active = input.registry.getActive(owner)
      return {
        operatorId: active.operatorId,
        profileId: active.profileId,
        projectId: active.projectId,
        sessionId: active.sessionId,
      }
    },

    snapshot() {
      const state = input.registry.snapshot()
      return {
        projects: state.projects.map(toV1Project),
        sessions: state.sessions.map(session => ({ ...session })),
      }
    },

    createSession(projectId: string, name: string): ProjectSessionRecord {
      return input.registry.createSession({ ...owner, projectId, name })
    },
  }
}

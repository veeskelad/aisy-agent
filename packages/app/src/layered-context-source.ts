import {
  ConfinementError,
  type ConfinementPort,
  type LayeredContextSource,
  type LazyContextExcerpt,
  type ProjectService,
  type ResolvedWorkBinding,
  type ScopedMemoryHit,
  type ScopedMemoryRouter,
  type TurnContextLease,
} from '@aisy/core'

const MAX_CONFINEMENT_READ_BYTES = 8 * 1024 * 1024
const MAX_MEMORY_HITS = 20

export interface WorkspaceLazyContextReader {
  readOptionalTextFiles(input: {
    turnLease: TurnContextLease
    paths: readonly string[]
    maxBytes: number
  }): Promise<ReadonlyMap<string, string>>
}

export class LayeredContextSourceError extends Error {
  constructor(public readonly code:
    | 'INVALID_LIMIT'
    | 'INVALID_DATE'
    | 'WORKSPACE_BINDING_MISMATCH'
    | 'RETRIEVAL_METADATA_MISSING'
    | 'RETRIEVAL_SCOPE_MISMATCH',
  ) {
    super(code)
    this.name = 'LayeredContextSourceError'
  }
}

function validLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new LayeredContextSourceError('INVALID_LIMIT')
  }
  return value
}

async function optionalProjectText(
  files: Pick<ConfinementPort, 'readText'>,
  lease: TurnContextLease,
  path: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    return await files.readText(lease, path, maxBytes)
  } catch (error) {
    if (error instanceof ConfinementError && error.code === 'NOT_FOUND') return null
    throw error
  }
}

function datePart(nowIso: string): string {
  const result = nowIso.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !new Date(`${result}T00:00:00.000Z`).toISOString().startsWith(result)) {
    throw new LayeredContextSourceError('INVALID_DATE')
  }
  return result
}

function fileExcerpt(input: {
  lease: TurnContextLease
  scope: 'global' | 'project'
  kind: LazyContextExcerpt['kind']
  path: string
  text: string | null | undefined
}): LazyContextExcerpt | null {
  if (input.text === null || input.text === undefined || input.text.trim().length === 0) return null
  return {
    scope: input.scope,
    scopeId: input.scope === 'global' ? 'global' : `project:${input.lease.projectId}`,
    ...(input.scope === 'project' ? { projectId: input.lease.projectId } : {}),
    kind: input.kind,
    rank: 0,
    sourcePath: input.path,
    provenanceRef: input.scope === 'global'
      ? `workspace-file:${input.path}`
      : `project-file:${input.lease.projectId}:${input.path}`,
    text: input.text,
  }
}

function retrievalExcerpt(
  hit: ScopedMemoryHit,
  lease: TurnContextLease,
  rank: number,
): LazyContextExcerpt {
  if (hit.scopeId === undefined || hit.sourcePath === undefined ||
    hit.provenanceRef === undefined) {
    throw new LayeredContextSourceError('RETRIEVAL_METADATA_MISSING')
  }
  const scopeMatches = hit.scope === 'global'
    ? hit.scopeId === 'global' && hit.projectId === undefined
    : lease.projectKind === 'project' && hit.scopeId === `project:${lease.projectId}` &&
      hit.projectId === lease.projectId
  if (!scopeMatches) throw new LayeredContextSourceError('RETRIEVAL_SCOPE_MISMATCH')
  return {
    scope: hit.scope,
    scopeId: hit.scopeId,
    ...(hit.projectId === undefined ? {} : { projectId: hit.projectId }),
    kind: 'retrieved',
    rank,
    sourcePath: hit.sourcePath,
    provenanceRef: hit.provenanceRef,
    text: hit.text,
  }
}

/** Reads global files under one exact Workspace binding, never the process cwd. */
export function makeWorkspaceLazyContextReader(deps: {
  service: Pick<ProjectService, 'acquireBoundContext' | 'assertBoundContext' | 'releaseTurnContext'>
  confinement: Pick<ConfinementPort, 'readText'>
  binding: ResolvedWorkBinding
}): WorkspaceLazyContextReader {
  const binding = Object.freeze({ ...deps.binding })
  if (binding.scope !== 'workspace') {
    throw new LayeredContextSourceError('WORKSPACE_BINDING_MISMATCH')
  }
  return Object.freeze<WorkspaceLazyContextReader>({
    async readOptionalTextFiles(input) {
      validLimit(input.maxBytes, MAX_CONFINEMENT_READ_BYTES)
      if (input.turnLease.operatorId !== binding.operatorId ||
        input.turnLease.profileId !== binding.profileId) {
        throw new LayeredContextSourceError('WORKSPACE_BINDING_MISMATCH')
      }
      const workspaceLease = deps.service.acquireBoundContext(binding)
      try {
        deps.service.assertBoundContext(workspaceLease, binding)
        if (workspaceLease.projectKind !== 'workspace' ||
          workspaceLease.operatorId !== input.turnLease.operatorId ||
          workspaceLease.profileId !== input.turnLease.profileId ||
          workspaceLease.projectId !== binding.projectId ||
          workspaceLease.sessionId !== binding.sessionId) {
          throw new LayeredContextSourceError('WORKSPACE_BINDING_MISMATCH')
        }
        const result = new Map<string, string>()
        for (const path of input.paths) {
          try {
            result.set(path, await deps.confinement.readText(workspaceLease, path, input.maxBytes))
          } catch (error) {
            if (!(error instanceof ConfinementError) || error.code !== 'NOT_FOUND') throw error
          }
        }
        return result
      } finally {
        await deps.service.releaseTurnContext(workspaceLease)
      }
    },
  })
}

/** ADR-0063 production source: Workspace files + exact active Project + scoped memory. */
export function makeLeaseBoundLayeredContextSource(deps: {
  workspaceFiles: WorkspaceLazyContextReader
  projectFiles: Pick<ConfinementPort, 'readText'>
  memory: Pick<ScopedMemoryRouter, 'searchAutomatic'>
  nowIso(): string
  limits: { fileBytes: number; memoryHits: number }
}): LayeredContextSource {
  const fileBytes = validLimit(deps.limits.fileBytes, MAX_CONFINEMENT_READ_BYTES)
  const memoryHits = validLimit(deps.limits.memoryHits, MAX_MEMORY_HITS)
  return Object.freeze<LayeredContextSource>({
    async load({ lease, query }) {
      const date = datePart(deps.nowIso())
      const globalPaths = [`memory/${date}.md`, 'knowledge/INDEX.md'] as const
      const projectFiles = lease.projectKind === 'project'
        ? [
            ['.current-task.md', 'current-task'],
            [`memory/${date}.md`, 'project-journal'],
            ['memory/INDEX.md', 'memory-catalogue'],
            ['knowledge/INDEX.md', 'knowledge-catalogue'],
          ] as const
        : []
      const [globalFiles, search, projectTexts] = await Promise.all([
        deps.workspaceFiles.readOptionalTextFiles({
          turnLease: lease,
          paths: globalPaths,
          maxBytes: fileBytes,
        }),
        deps.memory.searchAutomatic(lease, query, { limit: memoryHits }),
        Promise.all(projectFiles.map(async ([path, kind]) => ({
          path,
          kind,
          text: await optionalProjectText(deps.projectFiles, lease, path, fileBytes),
        }))),
      ])
      if (lease.projectKind === 'workspace' && search.degraded !== undefined) {
        throw new LayeredContextSourceError('RETRIEVAL_SCOPE_MISMATCH')
      }

      const globalExcerpts: LazyContextExcerpt[] = []
      const globalJournal = fileExcerpt({
        lease, scope: 'global', kind: 'daily-journal', path: globalPaths[0],
        text: globalFiles.get(globalPaths[0]),
      })
      const globalKnowledge = fileExcerpt({
        lease, scope: 'global', kind: 'knowledge-catalogue', path: globalPaths[1],
        text: globalFiles.get(globalPaths[1]),
      })
      if (globalJournal) globalExcerpts.push(globalJournal)
      if (globalKnowledge) globalExcerpts.push(globalKnowledge)

      const projectExcerpts: LazyContextExcerpt[] = []
      for (const item of projectTexts) {
        const value = fileExcerpt({
          lease,
          scope: 'project',
          kind: item.kind,
          path: item.path,
          text: item.text,
        })
        if (value) projectExcerpts.push(value)
      }

      let globalRank = 0
      let projectRank = 0
      for (const hit of search.hits) {
        const value = retrievalExcerpt(
          hit,
          lease,
          hit.scope === 'global' ? globalRank++ : projectRank++,
        )
        if (value.scope === 'global') globalExcerpts.push(value)
        else projectExcerpts.push(value)
      }

      return {
        globalExcerpts,
        project: {
          excerpts: projectExcerpts,
          ...(search.degraded === undefined
            ? {}
            : { degraded: 'PROJECT_RETRIEVAL_UNAVAILABLE' as const }),
        },
      }
    },
  })
}

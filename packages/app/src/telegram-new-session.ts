// Entering a session: a new one, or one the operator started days ago.
//
// The registry has `createSession` and `switchContext`, and the switch already
// accepts a target session — but nothing joined them, so the session controls
// could only create a session the operator then had no way to enter ("создана,
// текущая сессия не изменена"). This is the missing half, and resuming an
// existing session is the same half with the create step removed.
//
// The switch is authenticated the same way a project switch is: a one-use
// receipt bound to the exact target and generation. Nothing here weakens that —
// the receipt is minted and consumed inside one operator action.

import { createHash } from 'node:crypto'

import type {
  ProjectRegistryV2Owner,
  ProjectSessionRecord,
  SwitchAuthority,
} from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import type { SessionCreationCoordinator } from './session-creation-coordinator.js'

const RECEIPT_TTL_MS = 60_000

export type NewSessionResult =
  | { ok: true; session: ProjectSessionRecord; projectId: string }
  | { ok: false; errorCode: string }

export interface NewSessionRunner {
  (input: { requestKey: string; name?: string }): Promise<NewSessionResult>
}

export interface ResumeSessionRunner {
  (sessionId: string): Promise<NewSessionResult>
}

interface SessionSwitchDeps {
  runtime: Pick<NodeProjectServiceRuntime, 'registry' | 'authority' | 'service'>
  owner: ProjectRegistryV2Owner
  /** Distinguishes two taps of the same button; the receipt binds to it. */
  newRequestId: () => string
}

interface NewSessionDeps extends SessionSwitchDeps {
  creation: Pick<SessionCreationCoordinator, 'create'>
}

/**
 * Mints a receipt for `sessionId` and switches to it. `label` only varies the
 * hashed source so two different operator actions never share a receipt.
 */
async function switchToSession(
  deps: SessionSwitchDeps,
  projectId: string,
  session: ProjectSessionRecord,
  label: string,
): Promise<NewSessionResult> {
  const authority: SwitchAuthority = deps.runtime.authority
  // Read the generation again rather than reusing a pre-create value: the
  // receipt must match what the registry will compare it against, not what we
  // saw a moment ago.
  const current = deps.runtime.registry.getActive(deps.owner)
  if (current.projectId === projectId && current.sessionId === session.id) {
    return { ok: true, session, projectId }
  }
  const sourceMessageHash = createHash('sha256')
    .update(`${label}\0${session.id}\0${deps.newRequestId()}`)
    .digest('hex')
  const receipt = authority.issue({
    ...deps.owner,
    targetProjectId: projectId,
    targetSessionId: session.id,
    expectedGeneration: current.generation,
    sourceMessageHash,
  }, RECEIPT_TTL_MS)
  await deps.runtime.service.switchContext({
    ...deps.owner,
    targetProjectId: projectId,
    targetSessionId: session.id,
    receipt,
    sourceMessageHash,
  })
  return { ok: true, session, projectId }
}

/** A stable code only: registry and authority errors carry ids and generations
 *  that mean nothing to the operator. */
function failureCode(error: unknown, fallback: string): { ok: false; errorCode: string } {
  const code = (error as { code?: unknown }).code
  return { ok: false, errorCode: typeof code === 'string' ? code : fallback }
}

export function makeNewSessionRunner(input: NewSessionDeps): NewSessionRunner {
  return async (request): Promise<NewSessionResult> => {
    try {
      const active = input.runtime.registry.getActive(input.owner)
      const session = input.creation.create({
        ...input.owner,
        projectId: active.projectId,
        expectedGeneration: active.generation,
        requestKey: request.requestKey,
        ...(request.name === undefined || request.name.trim().length === 0
          ? {}
          : { name: request.name.trim() }),
      })
      return await switchToSession(input, active.projectId, session, 'new-session')
    } catch (error) {
      return failureCode(error, 'NEW_SESSION_FAILED')
    }
  }
}

/**
 * Enters an existing session of the active project. `switchContext` validates
 * that the session exists and belongs there, so a stale button cannot move the
 * operator into someone else's context.
 */
export function makeResumeSessionRunner(input: SessionSwitchDeps): ResumeSessionRunner {
  return async (sessionId: string): Promise<NewSessionResult> => {
    try {
      const active = input.runtime.registry.getActive(input.owner)
      if (sessionId === active.sessionId) {
        return { ok: false, errorCode: 'ALREADY_ACTIVE' }
      }
      const session = input.runtime.registry.getSession({
        ...input.owner,
        projectId: active.projectId,
        sessionId,
      })
      return await switchToSession(input, active.projectId, session, 'resume-session')
    } catch (error) {
      return failureCode(error, 'RESUME_SESSION_FAILED')
    }
  }
}

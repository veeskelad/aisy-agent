import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'

import type {
  HookCtx,
  PolicyRelaxationTarget,
  ToolCall,
  ToolExecutionContext,
} from '@aisy/core'
import {
  isProjectPolicyMode,
  resolveProjectPolicyResourcePath,
  type ProjectPolicyMode,
  type ProjectPolicyOverlayStore,
} from './project-policy-overlay.js'

interface PathIdentity {
  path: string
  device: bigint
  inode: bigint
}

interface PathHandle {
  turnId: string
  sessionId: string
  projectId: string
  relativePath: string
  policyRevision: number
  identities: PathIdentity[]
}

export interface ConversationalPolicyControl {
  /** Code-owned operator-visible target for a Tier-3 relaxation card. */
  describeRelaxation(call: ToolCall, context: HookCtx): PolicyRelaxationTarget | null
  configure(input: Readonly<{
    operation: string
    target: string
    value?: string
  }>, context: ToolExecutionContext):
    | {
        ok: true
        output: string
        outcome: 'policy-path-resolved' | 'policy-tightened' | 'policy-relaxed'
      }
    | { ok: false; output: string }
}

function modeLabel(mode: ProjectPolicyMode): string {
  switch (mode) {
    case 'ask-before-delete': return 'спрашивать перед удалением'
    case 'confirm-writes': return 'подтверждать изменения'
    case 'read-only': return 'только чтение'
    case 'no-egress': return 'без внешних подключений'
  }
}

function inspectPath(root: string, candidate: string): {
  relativePath: string
  identities: PathIdentity[]
} | null {
  const resolved = resolveProjectPolicyResourcePath(root, candidate)
  if (resolved === null) return null
  const paths = [root]
  if (resolved.relativePath !== '.') {
    let current = root
    for (const component of resolved.relativePath.split('/')) {
      current = join(current, component)
      paths.push(current)
    }
  }
  const identities: PathIdentity[] = []
  try {
    for (const path of paths) {
      const info = lstatSync(path, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink()) return null
      identities.push({ path, device: info.dev, inode: info.ino })
    }
  } catch {
    return null
  }
  return { relativePath: resolved.relativePath, identities }
}

function identityStillMatches(identity: PathIdentity): boolean {
  try {
    const current = lstatSync(identity.path, { bigint: true })
    return current.isDirectory() && !current.isSymbolicLink() &&
      current.dev === identity.device && current.ino === identity.inode
  } catch {
    return false
  }
}

export function makeConversationalPolicyControl(input: Readonly<{
  projectId: string
  projectRoot: string
  currentSessionId(): string
  store: ProjectPolicyOverlayStore
  newHandle?: () => string
}>): ConversationalPolicyControl {
  const handles = new Map<string, PathHandle>()
  const newHandle = input.newHandle ?? (() => randomUUID())

  const authentic = <T extends { sessionId?: string; turnId?: string }>(
    context: T,
  ): context is T & { sessionId: string; turnId: string } =>
    typeof context.turnId === 'string' && context.turnId.length > 0 &&
    context.sessionId === input.currentSessionId()

  const handleStillMatches = (record: PathHandle): boolean => {
    if (record.identities.some((identity) => !identityStillMatches(identity))) return false
    const inspected = inspectPath(input.projectRoot, record.relativePath)
    return inspected !== null && inspected.relativePath === record.relativePath &&
      inspected.identities.length === record.identities.length &&
      inspected.identities.every((identity, index) =>
        identity.device === record.identities[index]!.device &&
        identity.inode === record.identities[index]!.inode)
  }

  const consumeHandle = (handle: string, context: ToolExecutionContext): PathHandle | null => {
    const record = handles.get(handle)
    handles.delete(handle)
    if (record === undefined || !authentic(context) || record.turnId !== context.turnId ||
      record.sessionId !== context.sessionId || record.projectId !== input.projectId ||
      record.policyRevision !== input.store.revision() ||
      !handleStillMatches(record)) return null
    return record
  }

  const tighten = (
    relativePath: string | null,
    mode: ProjectPolicyMode,
    expectedRevision: number,
  ): ReturnType<ConversationalPolicyControl['configure']> => {
    if (relativePath !== null && (mode === 'no-egress' || mode === 'ask-before-delete')) {
      return {
        ok: false,
        output: 'Этот режим можно включить только для проекта целиком.',
      }
    }
    try {
      const outcome = input.store.tighten({
        projectId: input.projectId,
        relativePath,
        mode,
        expectedRevision,
      })
      if (outcome === 'stale') {
        return { ok: false, output: 'Настройки уже изменились. Выбери проект или папку ещё раз.' }
      }
      const where = relativePath === null ? 'в этом проекте' : `в папке ${relativePath}`
      return {
        ok: true,
        output: outcome === 'already-strict'
          ? `Уже настроено: ${where} — ${modeLabel(mode)}.`
          : `Настроил: ${where} — ${modeLabel(mode)}.`,
        outcome: 'policy-tightened',
      }
    } catch {
      return { ok: false, output: 'Не удалось сохранить настройку. Ничего не изменилось.' }
    }
  }

  const relax = (
    relativePath: string | null,
    mode: ProjectPolicyMode,
    expectedRevision: number,
    pathHandle?: PathHandle,
  ): ReturnType<ConversationalPolicyControl['configure']> => {
    try {
      const outcome = input.store.relax({
        projectId: input.projectId,
        relativePath,
        mode,
        expectedRevision,
      })
      if (outcome === 'stale') {
        return { ok: false, output: 'Настройки уже изменились. Выбери проект или папку ещё раз.' }
      }
      if (outcome === 'relaxed' && pathHandle !== undefined &&
        !handleStillMatches(pathHandle)) {
        // Store publication is synchronous and does not yield another agent
        // turn. Restore the exact strict mode before returning if an external
        // process swapped a component during persistence.
        const restored = input.store.tighten({
          projectId: input.projectId,
          relativePath,
          mode,
          expectedRevision: input.store.revision(),
        })
        if (restored !== 'tightened' && restored !== 'already-strict') {
          throw new Error('POLICY_RELAX_ROLLBACK_FAILED')
        }
        return { ok: false, output: 'Папка изменилась во время настройки. Строгий режим сохранён.' }
      }
      const where = relativePath === null ? 'в этом проекте' : `в папке ${relativePath}`
      return {
        ok: true,
        output: outcome === 'already-absent'
          ? `Этот строгий режим уже выключен ${where}.`
          : `Ослабил настройку ${where}: больше не ${modeLabel(mode)}.`,
        outcome: 'policy-relaxed',
      }
    } catch {
      return { ok: false, output: 'Не удалось изменить настройку. Ничего не изменилось.' }
    }
  }

  const resolvePath = (
    candidate: string,
    context: ToolExecutionContext,
  ): { ok: true; output: string } | { ok: false; output: string } => {
    if (!authentic(context)) return { ok: false, output: 'Не удалось выбрать папку в этом разговоре.' }
    const inspected = inspectPath(input.projectRoot, candidate)
    if (inspected === null) {
      return {
        ok: false,
        output: 'Не нашёл такую обычную папку внутри проекта. Символические ссылки не подходят.',
      }
    }
    if (inspected.relativePath === '.') {
      const overlays = input.store.snapshot().overlays
        .filter((overlay) => overlay.projectId === input.projectId)
        .sort((a, b) => (a.relativePath ?? '').localeCompare(b.relativePath ?? ''))
      if (overlays.length === 0) return { ok: true, output: 'Строгих настроек нет.' }
      return {
        ok: true,
        output: `Строгие настройки:\n${overlays.map((overlay) =>
          `• ${overlay.relativePath ?? 'весь проект'} — ${overlay.modes.map(modeLabel).join(', ')}`
        ).join('\n')}`,
      }
    }
    if (handles.size >= 1_000) handles.clear()
    const handle = newHandle()
    handles.set(handle, {
      turnId: context.turnId,
      sessionId: context.sessionId,
      projectId: input.projectId,
      relativePath: inspected.relativePath,
      policyRevision: input.store.revision(),
      identities: inspected.identities,
    })
    return { ok: true, output: `• ${handle} — ${inspected.relativePath}` }
  }

  return Object.freeze<ConversationalPolicyControl>({
    describeRelaxation(call, context) {
      if (call.name !== 'configure_agent' || !authentic(context) ||
        typeof call.args['operation'] !== 'string' ||
        typeof call.args['target'] !== 'string' ||
        !isProjectPolicyMode(call.args['value'])) return null
      if (call.args['operation'] === 'policy.relax-project') {
        return call.args['target'] === 'current' ? { scope: 'project' } : null
      }
      if (call.args['operation'] !== 'policy.relax-path') return null
      const record = handles.get(call.args['target'])
      if (record === undefined || record.turnId !== context.turnId ||
        record.sessionId !== context.sessionId || record.projectId !== input.projectId ||
        record.policyRevision !== input.store.revision() || !handleStillMatches(record)) return null
      return { scope: 'path', relativePath: record.relativePath }
    },
    configure(request, context) {
      if (request.operation === 'policy.resolve-path') {
        if (request.target !== 'current') {
          return { ok: false, output: 'Не удалось выбрать папку в этом проекте.' }
        }
        const resolved = resolvePath(request.value?.trim() ?? '', context)
        return resolved.ok
          ? { ...resolved, outcome: 'policy-path-resolved' }
          : resolved
      }
      const mode = request.value?.trim()
      if (!isProjectPolicyMode(mode)) {
        return { ok: false, output: 'Выбери один режим: подтверждать изменения, только чтение, без внешних подключений или спрашивать перед удалением.' }
      }
      if (request.operation === 'policy.tighten-project') {
        if (!authentic(context) || request.target !== 'current') {
          return { ok: false, output: 'Не удалось применить настройку к этому проекту.' }
        }
        return tighten(null, mode, input.store.revision())
      }
      if (request.operation === 'policy.tighten-path') {
        const handle = consumeHandle(request.target, context)
        if (handle === null) {
          return { ok: false, output: 'Папка или настройки изменились. Выбери папку ещё раз.' }
        }
        return tighten(handle.relativePath, mode, handle.policyRevision)
      }
      if (request.operation === 'policy.relax-project') {
        if (!authentic(context) || request.target !== 'current') {
          return { ok: false, output: 'Не удалось применить настройку к этому проекту.' }
        }
        return relax(null, mode, input.store.revision())
      }
      if (request.operation === 'policy.relax-path') {
        const handle = consumeHandle(request.target, context)
        if (handle === null) {
          return { ok: false, output: 'Папка или настройки изменились. Выбери папку ещё раз.' }
        }
        return relax(handle.relativePath, mode, handle.policyRevision, handle)
      }
      return { ok: false, output: 'Эта настройка недоступна.' }
    },
  })
}

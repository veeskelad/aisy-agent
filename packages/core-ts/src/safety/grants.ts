// Context-bound approval grants (ADR-0047 + workspace/project context spec §11).
//
// Session grants remain process-local. New durable "always" grants use a
// code-derived schema-v3 matcher; schema-v2 tool grants stay compatibility-only.
// Legacy `{ always: string[] }` files are quarantined and never authorize.

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { types as utilTypes } from 'node:util'

import type {
  GrantBinding,
  GrantListEntry,
  GrantPersistencePort,
  GrantPersistenceStateV2,
  GrantPersistenceStateV3,
  GrantScope,
  GrantStore,
  PersistedApprovalGrantV2,
  PersistedSimilarApprovalGrantV3,
  Tier,
  ToolCall,
} from './types.js'

export class GrantStoreError extends Error {
  constructor(public readonly code: 'INVALID_TOOL' | 'INVALID_BINDING') {
    super(code)
    this.name = 'GrantStoreError'
  }
}

export interface GrantStoreDeps {
  /** Persistence for bound "always" grants. Absent means process-local only. */
  persistence?: GrantPersistencePort
  /** Runtime lifecycle check; false disables a grant before tool execution. */
  isBindingUsable?: (binding: GrantBinding) => boolean
  nowIso?: () => string
  /** Changing this code-owned revision invalidates older similarity rules. */
  policyRevision?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function cleanTool(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new GrantStoreError('INVALID_TOOL')
  }
  return value.trim()
}

function cleanBinding(value: unknown): GrantBinding {
  const input = record(value)
  if (!input || typeof input['operatorId'] !== 'string' || input['operatorId'].trim().length === 0 ||
    typeof input['profileId'] !== 'string' || input['profileId'].trim().length === 0 ||
    typeof input['projectId'] !== 'string' || input['projectId'].trim().length === 0 ||
    (input['scope'] !== 'workspace' && input['scope'] !== 'project' && input['scope'] !== 'session') ||
    (input['sessionId'] !== undefined &&
      (typeof input['sessionId'] !== 'string' || input['sessionId'].trim().length === 0)) ||
    (input['scope'] === 'session' && typeof input['sessionId'] !== 'string')) {
    throw new GrantStoreError('INVALID_BINDING')
  }
  return {
    operatorId: input['operatorId'].trim(),
    profileId: input['profileId'].trim(),
    projectId: input['projectId'].trim(),
    ...(input['sessionId'] === undefined ? {} : { sessionId: input['sessionId'].trim() }),
    scope: input['scope'],
  }
}

function sameOwner(a: GrantBinding, b: GrantBinding): boolean {
  return a.operatorId === b.operatorId && a.profileId === b.profileId
}

function covers(grant: GrantBinding, current: GrantBinding): boolean {
  if (!sameOwner(grant, current) || grant.projectId !== current.projectId) return false
  if (grant.scope === 'session') return grant.sessionId === current.sessionId
  return grant.scope === current.scope
}

function contextBinding(binding: GrantBinding, scope: GrantScope): GrantBinding {
  const clean = cleanBinding(binding)
  if (scope === 'session') {
    if (clean.sessionId === undefined) throw new GrantStoreError('INVALID_BINDING')
    return { ...clean, scope: 'session', sessionId: clean.sessionId }
  }
  // "always" means always in the current declared scope. It never promotes a
  // session binding to project/global and never turns Workspace into Project.
  if (clean.scope === 'session') return clean
  return {
    operatorId: clean.operatorId,
    profileId: clean.profileId,
    projectId: clean.projectId,
    scope: clean.scope,
  }
}

function bindingKey(binding: GrantBinding): string {
  return [binding.operatorId, binding.profileId, binding.projectId,
    binding.scope, binding.sessionId ?? ''].join('\u0000')
}

function grantKey(tool: string, binding: GrantBinding): string {
  return `${cleanTool(tool)}\u0000${bindingKey(binding)}`
}

interface SimilarDescriptor {
  tool: string
  operation: string
  resourceHash: string
  policyRevision: string
  riskCeiling: 2
}

const HASH = /^[a-f0-9]{64}$/
const SIMPLE_SHELL = /^[A-Za-z0-9_@%+=:,./\- \t]+$/
const SUBCOMMAND_TOOLS = new Set([
  'cargo', 'docker', 'gh', 'git', 'go', 'kubectl', 'npm', 'pnpm', 'uv', 'yarn',
])
const SHELL_INTERPRETERS = new Set(['bash', 'dash', 'fish', 'sh', 'zsh'])

function hashResource(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function safeArgs(value: unknown): Record<string, unknown> | null {
  let nodes = 0
  let stringBytes = 0
  const snapshot = (item: unknown, depth: number): unknown => {
    nodes++
    if (nodes > 2048 || depth > 16) throw new Error('bounded JSON exceeded')
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('non-finite JSON number')
      return item
    }
    if (typeof item === 'string') {
      stringBytes += Buffer.byteLength(item, 'utf8')
      if (stringBytes > 64 * 1024) throw new Error('bounded JSON exceeded')
      return item
    }
    if (typeof item !== 'object' || utilTypes.isProxy(item)) throw new Error('non-JSON value')
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 256 ||
        Object.getOwnPropertySymbols(item).length > 0) throw new Error('unsafe JSON array')
      const descriptors = Object.getOwnPropertyDescriptors(item)
      if (Object.keys(descriptors).some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
        throw new Error('unsafe JSON array')
      }
      const out: unknown[] = []
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
          throw new Error('sparse/accessor JSON array')
        }
        out.push(snapshot(descriptor.value, depth + 1))
      }
      return out
    }
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('unsafe JSON object')
    const descriptors = Object.getOwnPropertyDescriptors(item)
    const keys = Object.keys(descriptors)
    if (keys.length > 128 || Object.getOwnPropertySymbols(item).length > 0) {
      throw new Error('unsafe JSON object')
    }
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys.sort()) {
      const descriptor = descriptors[key]!
      if (!('value' in descriptor) || descriptor.enumerable !== true) throw new Error('accessor JSON object')
      out[key] = snapshot(descriptor.value, depth + 1)
    }
    return out
  }
  try {
    const captured = snapshot(value, 0)
    if (typeof captured !== 'object' || captured === null || Array.isArray(captured)) return null
    return captured as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * The host of a fetchable URL, or null if it is not one we would fetch.
 *
 * A page grant is per domain, not per link: the operator answers "this site is
 * fine", and the path — which may carry a token — is deliberately not part of
 * what is remembered or shown. Shared with the approval card so the operator
 * approves exactly what the grant will cover.
 */
export function httpsHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.length === 0) return null
    return url.hostname.toLowerCase()
  } catch {
    return null
  }
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return null
  const normalized = posix.normalize(value.replaceAll('\\', '/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null
  return normalized
}

/** Conservative v3 projection. Payload fields are excluded only for tools
 * whose resource boundary is explicit; generic/MCP calls use exact args. */
function similarDescriptor(rawCall: ToolCall, risk: Tier, policyRevision: string): SimilarDescriptor | null {
  if (risk !== 2) return null
  if (typeof rawCall !== 'object' || rawCall === null || utilTypes.isProxy(rawCall) ||
    Object.getPrototypeOf(rawCall) !== Object.prototype) return null
  const callDescriptors = Object.getOwnPropertyDescriptors(rawCall)
  const toolValue = callDescriptors['tool']
  const argsValue = callDescriptors['args']
  if (toolValue === undefined || argsValue === undefined || !('value' in toolValue) ||
    !('value' in argsValue) || toolValue.enumerable !== true || argsValue.enumerable !== true) return null
  let tool: string
  try { tool = cleanTool(toolValue.value) } catch { return null }
  const args = safeArgs(argsValue.value)
  if (args === null) return null

  if (tool === 'write_file' || tool === 'write_knowledge') {
    const path = safeRelativePath(args['path'])
    if (path === null) return null
    return { tool, operation: 'write', resourceHash: hashResource({ path }), policyRevision, riskCeiling: 2 }
  }
  if (tool === 'remember') {
    const topic = typeof args['topic'] === 'string' && args['topic'].length <= 64
      ? args['topic'].trim().toLowerCase() || 'general'
      : 'general'
    return { tool, operation: 'remember', resourceHash: hashResource({ topic }), policyRevision, riskCeiling: 2 }
  }
  if (tool === 'bash') {
    const cmd = args['cmd']
    if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 8192 || !SIMPLE_SHELL.test(cmd)) return null
    const tokens = cmd.trim().split(/\s+/)
    if (tokens.length === 0 || tokens.length > 64) return null
    const executable = posix.basename(tokens[0]!).toLowerCase()
    if (executable.includes('=') || executable === 'env' || executable === 'export' ||
      SHELL_INTERPRETERS.has(executable)) return null
    const hasSubcommand = SUBCOMMAND_TOOLS.has(executable) && tokens.length > 1 &&
      !tokens[1]!.startsWith('-') && !tokens[1]!.includes('/') && !tokens[1]!.includes('=')
    const operation = `bash:${executable}${hasSubcommand ? `:${tokens[1]!.toLowerCase()}` : ''}`
    const operands = tokens.slice(hasSubcommand ? 2 : 1)
    return { tool, operation, resourceHash: hashResource({ operands }), policyRevision, riskCeiling: 2 }
  }
  if (tool === 'fetch_url') {
    const host = httpsHost(args['url'])
    if (host === null) return null
    return { tool, operation: 'fetch', resourceHash: hashResource({ host }), policyRevision, riskCeiling: 2 }
  }
  if (tool === 'spawn_subagent') return null

  let encoded: string
  try { encoded = JSON.stringify(args) } catch { return null }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) return null
  return { tool, operation: tool, resourceHash: hashResource(args), policyRevision, riskCeiling: 2 }
}

/**
 * Тот же разбор вызова, но для обучаемой автономности (спека 24).
 *
 * Ключ рабочего процесса обязан пониматься так же, как «похожее действие» из
 * ADR-0093: если код считает два вызова одинаковыми при подтверждении, он не
 * может считать их разными при обучении — иначе оператор подтверждает одно, а
 * агент учится другому. Поэтому здесь ровно та же проекция, без ревизии
 * политики: политика меняется, а рабочий процесс остаётся тем же.
 *
 * `null` означает «этот вызов не входит ни в один процесс»: составная shell-
 * команда, делегирование, аргументы, которые нельзя свести к ресурсу.
 */
export function autonomyWorkflowStep(
  call: ToolCall,
): { tool: string; argClass: string; resourceMask: string } | null {
  const descriptor = similarDescriptor(call, 2, 'autonomy')
  if (descriptor === null) return null
  return {
    tool: descriptor.tool,
    argClass: descriptor.operation,
    resourceMask: descriptor.resourceHash,
  }
}

function similarKey(value: SimilarDescriptor, binding: GrantBinding): string {
  return [value.tool, value.operation, value.resourceHash, value.policyRevision,
    value.riskCeiling, bindingKey(binding)].join('\u0000')
}

function parsePersisted(value: unknown): {
  grants: PersistedApprovalGrantV2[]
  similarGrants: PersistedSimilarApprovalGrantV3[]
  quarantinedLegacyTools: string[]
  invalidRecordCount: number
} {
  const input = record(value)
  if (!input) return { grants: [], similarGrants: [], quarantinedLegacyTools: [], invalidRecordCount: 0 }

  // v1 was `{ "always": ["bash", ...] }`. Preserve names for explicit
  // reassignment, but do not let them authorize any context.
  if (Array.isArray(input['always'])) {
    const quarantinedLegacyTools = [...new Set(input['always'].flatMap((item) => {
      try { return [cleanTool(item)] } catch { return [] }
    }))]
    return { grants: [], similarGrants: [], quarantinedLegacyTools, invalidRecordCount: 0 }
  }

  if (input['schemaVersion'] !== 2 && input['schemaVersion'] !== 3) {
    return { grants: [], similarGrants: [], quarantinedLegacyTools: [], invalidRecordCount: 1 }
  }
  const rawLegacy = input['schemaVersion'] === 2 ? input['grants'] : input['legacyToolGrants'] ?? []
  const rawSimilar = input['schemaVersion'] === 3 ? input['similarGrants'] : []
  if (!Array.isArray(rawLegacy) || !Array.isArray(rawSimilar)) {
    return { grants: [], similarGrants: [], quarantinedLegacyTools: [], invalidRecordCount: 1 }
  }
  const grants: PersistedApprovalGrantV2[] = []
  let invalidRecordCount = Number.isSafeInteger(input['invalidRecordCount']) &&
    Number(input['invalidRecordCount']) >= 0 ? Number(input['invalidRecordCount']) : 0
  for (const candidate of rawLegacy) {
    const item = record(candidate)
    try {
      if (!item || item['schemaVersion'] !== 2 || item['scope'] !== 'always' ||
        typeof item['createdAt'] !== 'string' || item['createdAt'].trim().length === 0) {
        throw new GrantStoreError('INVALID_BINDING')
      }
      const grant: PersistedApprovalGrantV2 = {
        schemaVersion: 2,
        tool: cleanTool(item['tool']),
        scope: 'always',
        binding: cleanBinding(item['binding']),
        createdAt: item['createdAt'],
      }
      grants.push(grant)
    } catch {
      invalidRecordCount++
    }
  }
  const similarGrants: PersistedSimilarApprovalGrantV3[] = []
  for (const candidate of rawSimilar) {
    const item = record(candidate)
    try {
      if (!item || item['schemaVersion'] !== 3 || item['kind'] !== 'similar' ||
        item['scope'] !== 'always' || item['riskCeiling'] !== 2 ||
        typeof item['operation'] !== 'string' || item['operation'].length === 0 ||
        item['operation'].length > 240 || typeof item['resourceHash'] !== 'string' ||
        !HASH.test(item['resourceHash']) || typeof item['policyRevision'] !== 'string' ||
        item['policyRevision'].length === 0 || item['policyRevision'].length > 128 ||
        typeof item['createdAt'] !== 'string' ||
        item['createdAt'].trim().length === 0) throw new GrantStoreError('INVALID_BINDING')
      similarGrants.push({
        schemaVersion: 3,
        kind: 'similar',
        tool: cleanTool(item['tool']),
        operation: item['operation'],
        resourceHash: item['resourceHash'],
        policyRevision: item['policyRevision'],
        riskCeiling: 2,
        scope: 'always',
        binding: cleanBinding(item['binding']),
        createdAt: item['createdAt'],
      })
    } catch { invalidRecordCount++ }
  }
  const quarantinedLegacyTools = Array.isArray(input['quarantinedLegacyTools'])
    ? [...new Set(input['quarantinedLegacyTools'].flatMap((item) => {
      try { return [cleanTool(item)] } catch { return [] }
    }))]
    : []
  return { grants, similarGrants, quarantinedLegacyTools, invalidRecordCount }
}

export function makeGrantStore(deps: GrantStoreDeps = {}): GrantStore {
  const loaded = parsePersisted(deps.persistence?.load())
  const session = new Map<string, { tool: string; scope: 'session'; binding: GrantBinding }>()
  const always = new Map<string, PersistedApprovalGrantV2>()
  const similarSession = new Map<string, PersistedSimilarApprovalGrantV3>()
  const similarAlways = new Map<string, PersistedSimilarApprovalGrantV3>()
  for (const item of loaded.grants) always.set(grantKey(item.tool, item.binding), item)
  for (const item of loaded.similarGrants) similarAlways.set(similarKey(item, item.binding), item)
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const policyRevision = deps.policyRevision ?? 'similar-grant-v1'
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(policyRevision)) {
    throw new GrantStoreError('INVALID_BINDING')
  }

  const usable = (binding: GrantBinding): boolean => {
    try {
      return deps.isBindingUsable?.(binding) ?? true
    } catch {
      return false
    }
  }

  const persist = (): void => {
    if (!deps.persistence) return
    const common = {
      ...(loaded.quarantinedLegacyTools.length === 0
        ? {} : { quarantinedLegacyTools: [...loaded.quarantinedLegacyTools] }),
      ...(loaded.invalidRecordCount === 0
        ? {} : { invalidRecordCount: loaded.invalidRecordCount }),
    }
    const state: GrantPersistenceStateV2 | GrantPersistenceStateV3 = similarAlways.size === 0
      ? { schemaVersion: 2, grants: [...always.values()], ...common }
      : {
          schemaVersion: 3,
          similarGrants: [...similarAlways.values()],
          ...(always.size === 0 ? {} : { legacyToolGrants: [...always.values()] }),
          ...common,
        }
    deps.persistence.save(state)
  }

  return {
    has(tool, rawBinding) {
      if (rawBinding === undefined) return false
      let binding: GrantBinding
      let normalizedTool: string
      try {
        binding = cleanBinding(rawBinding)
        normalizedTool = cleanTool(tool)
      } catch {
        return false
      }
      if (!usable(binding)) return false
      return [...session.values(), ...always.values()].some((grant) =>
        grant.tool === normalizedTool && covers(grant.binding, binding) && usable(grant.binding))
    },

    record(tool, scope, rawBinding) {
      if (rawBinding === undefined) throw new GrantStoreError('INVALID_BINDING')
      const normalizedTool = cleanTool(tool)
      const binding = contextBinding(rawBinding, scope)
      if (!usable(binding)) throw new GrantStoreError('INVALID_BINDING')
      const key = grantKey(normalizedTool, binding)
      if (scope === 'always') {
        // Durable scope supersedes an identical process-local scope only. It
        // never deletes a narrower grant in another session/project.
        session.delete(key)
        if (!always.has(key)) {
          const candidate: PersistedApprovalGrantV2 = {
            schemaVersion: 2,
            tool: normalizedTool,
            scope: 'always',
            binding,
            createdAt: nowIso(),
          }
          always.set(key, candidate)
          try { persist() } catch (error) {
            always.delete(key)
            throw error
          }
        }
        return
      }
      if (!always.has(key)) session.set(key, { tool: normalizedTool, scope: 'session', binding })
    },

    hasSimilar(call, risk, rawBinding) {
      if (rawBinding === undefined) return false
      let binding: GrantBinding
      try { binding = cleanBinding(rawBinding) } catch { return false }
      if (!usable(binding)) return false
      const descriptor = similarDescriptor(call, risk, policyRevision)
      if (descriptor === null) return false
      return [...similarSession.values(), ...similarAlways.values()].some((grant) =>
        grant.tool === descriptor.tool && grant.operation === descriptor.operation &&
        grant.resourceHash === descriptor.resourceHash && risk <= grant.riskCeiling &&
        grant.policyRevision === descriptor.policyRevision &&
        covers(grant.binding, binding) && usable(grant.binding))
    },

    canRememberSimilar(call, risk) {
      return similarDescriptor(call, risk, policyRevision) !== null
    },

    recordSimilar(call, risk, scope, rawBinding) {
      if (rawBinding === undefined) throw new GrantStoreError('INVALID_BINDING')
      const descriptor = similarDescriptor(call, risk, policyRevision)
      if (descriptor === null) throw new GrantStoreError('INVALID_TOOL')
      const binding = contextBinding(rawBinding, scope)
      if (!usable(binding)) throw new GrantStoreError('INVALID_BINDING')
      const key = similarKey(descriptor, binding)
      if (scope === 'always') {
        similarSession.delete(key)
        if (!similarAlways.has(key)) {
          const candidate: PersistedSimilarApprovalGrantV3 = {
            schemaVersion: 3,
            kind: 'similar',
            ...descriptor,
            scope: 'always',
            binding,
            createdAt: nowIso(),
          }
          similarAlways.set(key, candidate)
          try { persist() } catch (error) {
            similarAlways.delete(key)
            throw error
          }
        }
        return
      }
      if (!similarAlways.has(key)) {
        similarSession.set(key, {
          schemaVersion: 3,
          kind: 'similar',
          ...descriptor,
          scope: 'always',
          binding,
          createdAt: nowIso(),
        })
      }
    },

    revoke(tool, rawBinding) {
      const normalizedTool = cleanTool(tool)
      let changedAlways = false
      if (rawBinding === undefined) {
        for (const [key, grant] of session) if (grant.tool === normalizedTool) session.delete(key)
        for (const [key, grant] of similarSession) if (grant.tool === normalizedTool) similarSession.delete(key)
        for (const [key, grant] of always) {
          if (grant.tool === normalizedTool) {
            always.delete(key)
            changedAlways = true
          }
        }
        for (const [key, grant] of similarAlways) {
          if (grant.tool === normalizedTool) {
            similarAlways.delete(key)
            changedAlways = true
          }
        }
      } else {
        const binding = cleanBinding(rawBinding)
        for (const [key, grant] of session) {
          if (grant.tool === normalizedTool && covers(grant.binding, binding)) session.delete(key)
        }
        for (const [key, grant] of always) {
          if (grant.tool === normalizedTool && covers(grant.binding, binding)) {
            always.delete(key)
            changedAlways = true
          }
        }
        for (const [key, grant] of similarSession) {
          if (grant.tool === normalizedTool && covers(grant.binding, binding)) similarSession.delete(key)
        }
        for (const [key, grant] of similarAlways) {
          if (grant.tool === normalizedTool && covers(grant.binding, binding)) {
            similarAlways.delete(key)
            changedAlways = true
          }
        }
      }
      if (changedAlways) persist()
    },

    revokeAll(rawBinding) {
      let changedAlways = false
      if (rawBinding === undefined) {
        session.clear()
        similarSession.clear()
        changedAlways = always.size > 0 || similarAlways.size > 0
        always.clear()
        similarAlways.clear()
      } else {
        const binding = cleanBinding(rawBinding)
        for (const [key, grant] of session) if (covers(grant.binding, binding)) session.delete(key)
        for (const [key, grant] of similarSession) {
          if (covers(grant.binding, binding)) similarSession.delete(key)
        }
        for (const [key, grant] of always) {
          if (covers(grant.binding, binding)) {
            always.delete(key)
            changedAlways = true
          }
        }
        for (const [key, grant] of similarAlways) {
          if (covers(grant.binding, binding)) {
            similarAlways.delete(key)
            changedAlways = true
          }
        }
      }
      if (changedAlways) persist()
    },

    list(rawBinding) {
      const current = rawBinding === undefined ? undefined : cleanBinding(rawBinding)
      const out: GrantListEntry[] = []
      for (const grant of [...always.values(), ...session.values()]) {
        if (current !== undefined && !covers(grant.binding, current)) continue
        const active = usable(grant.binding)
        out.push({
          tool: grant.tool,
          scope: grant.scope,
          kind: 'legacy-tool',
          binding: grant.binding,
          status: active ? 'active' : 'disabled',
          ...(active ? {} : { disabledReason: 'context-unavailable' as const }),
        })
      }
      for (const grant of [...similarAlways.values(), ...similarSession.values()]) {
        if (current !== undefined && !covers(grant.binding, current)) continue
        const revisionMatches = grant.policyRevision === policyRevision
        const active = usable(grant.binding) && revisionMatches
        out.push({
          tool: grant.tool,
          scope: similarAlways.has(similarKey(grant, grant.binding)) ? 'always' : 'session',
          kind: 'similar',
          operation: grant.operation,
          resourceHashPrefix: grant.resourceHash.slice(0, 12),
          binding: grant.binding,
          status: active ? 'active' : 'disabled',
          ...(active ? {} : {
            disabledReason: revisionMatches
              ? 'context-unavailable' as const
              : 'policy-revision-mismatch' as const,
          }),
        })
      }
      for (const tool of loaded.quarantinedLegacyTools) {
        out.push({ tool, scope: 'always', status: 'disabled', disabledReason: 'legacy-unscoped' })
      }
      return out
    },
  }
}

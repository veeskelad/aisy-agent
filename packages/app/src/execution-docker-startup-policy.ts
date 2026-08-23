export const OWNED_DOCKER_PARENT_BROKER_REQUIRED = 'OWNED_DOCKER_PARENT_BROKER_REQUIRED' as const

const CHILD_OWNED_DOCKER_ENV = new Set([
  'AISY_DOCKER',
  'AISY_RESTRICTED_CLONE_ENABLED',
  'AISY_RESTRICTED_CLONE_GATEWAY_IMAGE',
  'AISY_RESTRICTED_CLONE_WORKER_IMAGE',
  'AISY_SANDBOX_GVISOR',
  'AISY_SANDBOX_IMAGE',
  'AISY_WHISPER_IMAGE',
])

const INVALID_VALUE = Symbol('invalid-value')

function ownString(source: unknown, key: string): string | undefined | typeof INVALID_VALUE {
  try {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return INVALID_VALUE
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) return undefined
    if (!('value' in descriptor) || !descriptor.enumerable ||
      typeof descriptor.value !== 'string') return INVALID_VALUE
    return descriptor.value
  } catch {
    return INVALID_VALUE
  }
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

function restrictedCloneEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

/**
 * Legacy child-owned Docker activation is refused until the parent-owned broker
 * can bind every daemon effect to its durable authority epoch.
 */
export function executionDockerStartupRefusal(
  source: unknown,
): typeof OWNED_DOCKER_PARENT_BROKER_REQUIRED | null {
  const sandboxImage = ownString(source, 'AISY_SANDBOX_IMAGE')
  const whisperImage = ownString(source, 'AISY_WHISPER_IMAGE')
  const restrictedClone = ownString(source, 'AISY_RESTRICTED_CLONE_ENABLED')
  if (sandboxImage === INVALID_VALUE || whisperImage === INVALID_VALUE ||
    restrictedClone === INVALID_VALUE) return OWNED_DOCKER_PARENT_BROKER_REQUIRED
  return nonEmpty(sandboxImage) || nonEmpty(whisperImage) || restrictedCloneEnabled(restrictedClone)
    ? OWNED_DOCKER_PARENT_BROKER_REQUIRED
    : null
}

/** Defense in depth for callers that construct the parent supervisor directly. */
export function withoutChildOwnedDockerEnv(
  source: unknown,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {}
  try {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      return Object.freeze(sanitized)
    }
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== 'string' || CHILD_OWNED_DOCKER_ENV.has(key) ||
        key.startsWith('AISY_OWNED_DOCKER_') || key.startsWith('DOCKER_')) continue
      const descriptor = Object.getOwnPropertyDescriptor(source, key)
      if (descriptor !== undefined && 'value' in descriptor && descriptor.enumerable &&
        typeof descriptor.value === 'string') {
        Object.defineProperty(sanitized, key, {
          value: descriptor.value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
  } catch {
    return Object.freeze({})
  }
  return Object.freeze(sanitized)
}

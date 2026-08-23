import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'

export const PROVIDER_BROKER_SOCKET_PATH = '/run/aisy/provider/control.sock'
export const PROVIDER_BROKER_READY_PATH = '/run/aisy/provider/ready.json'

export type BrokerNativeProviderId =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'deepseek'
  | 'qwen'
  | 'glm'
  | 'gemini'

const PROVIDERS = new Set<BrokerNativeProviderId>([
  'openai', 'anthropic', 'openrouter', 'deepseek', 'qwen', 'glm', 'gemini',
])
const HASH = /^[a-f0-9]{64}$/

interface FileFacts {
  uid: number
  mode: number
  size: number
  kind: 'file' | 'socket' | 'other'
}

export interface ProviderBrokerReadinessPort {
  facts(path: string): FileFacts | null
  read(path: string, maximumBytes: number): string | null
}

export interface ProviderBrokerReadyV1 {
  protocolVersion: 1
  installationHash: string
  releaseDigest: string
  providers: readonly BrokerNativeProviderId[]
}

export interface ProviderBrokerDoctorFinding {
  state: 'ready' | 'unconfigured' | 'unavailable' | 'drifted' | 'incompatible' | 'unsupported'
  readyProviders: readonly BrokerNativeProviderId[]
}

export function makeNodeProviderBrokerReadinessPort(): ProviderBrokerReadinessPort {
  return Object.freeze({
    facts(path: string): FileFacts | null {
      try {
        const value = lstatSync(path)
        return {
          uid: value.uid,
          mode: value.mode & 0o777,
          size: value.size,
          kind: value.isFile() ? 'file' : value.isSocket() ? 'socket' : 'other',
        }
      } catch {
        return null
      }
    },
    read(path: string, maximumBytes: number): string | null {
      let descriptor = -1
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const value = fstatSync(descriptor)
        if (!value.isFile() || value.uid !== 0 || (value.mode & 0o022) !== 0 ||
          value.size < 1 || value.size > maximumBytes) return null
        return readFileSync(descriptor, 'utf8')
      } catch {
        return null
      } finally {
        if (descriptor >= 0) closeSync(descriptor)
      }
    },
  })
}

export function asBrokerNativeProviderId(value: string): BrokerNativeProviderId | null {
  return PROVIDERS.has(value as BrokerNativeProviderId) ? value as BrokerNativeProviderId : null
}

export function inspectProviderBrokerReady(input: {
  platform: NodeJS.Platform
  selectedProviders: readonly string[]
  port: ProviderBrokerReadinessPort
  expectedInstallationHash?: string
  socketPath?: string
  readyPath?: string
}): ProviderBrokerReadyV1 | null {
  if (input.platform !== 'linux') return null
  const selected = input.selectedProviders.map(asBrokerNativeProviderId)
  if (selected.some(value => value === null)) return null
  const socket = input.port.facts(input.socketPath ?? PROVIDER_BROKER_SOCKET_PATH)
  const readyFacts = input.port.facts(input.readyPath ?? PROVIDER_BROKER_READY_PATH)
  if (socket === null || socket.kind !== 'socket' || socket.uid !== 0 || (socket.mode & 0o007) !== 0 ||
    readyFacts === null || readyFacts.kind !== 'file' || readyFacts.uid !== 0 ||
    (readyFacts.mode & 0o022) !== 0 || readyFacts.size < 1 || readyFacts.size > 4096) return null
  const raw = input.port.read(input.readyPath ?? PROVIDER_BROKER_READY_PATH, 4096)
  if (raw === null) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'installationHash,protocolVersion,providers,releaseDigest' ||
    record['protocolVersion'] !== 1 || typeof record['installationHash'] !== 'string' ||
    !HASH.test(record['installationHash']) || typeof record['releaseDigest'] !== 'string' ||
    !HASH.test(record['releaseDigest']) || !Array.isArray(record['providers']) ||
    record['providers'].some(item => typeof item !== 'string' ||
      asBrokerNativeProviderId(item) === null) || new Set(record['providers']).size !== record['providers'].length) return null
  const providers = record['providers'] as BrokerNativeProviderId[]
  if (input.expectedInstallationHash !== undefined &&
    record['installationHash'] !== input.expectedInstallationHash) return null
  if (selected.some(item => !providers.includes(item!))) return null
  return Object.freeze({
    protocolVersion: 1,
    installationHash: record['installationHash'],
    releaseDigest: record['releaseDigest'],
    providers: Object.freeze([...providers]),
  })
}

export function inspectProviderBrokerDoctor(input: {
  platform: NodeJS.Platform
  selectedProviders: readonly string[]
  port: ProviderBrokerReadinessPort
  expectedInstallationHash: string
  socketPath?: string
  readyPath?: string
}): ProviderBrokerDoctorFinding {
  if (input.platform !== 'linux') return Object.freeze({ state: 'unsupported', readyProviders: [] })
  if (!HASH.test(input.expectedInstallationHash) ||
    input.selectedProviders.some(value => asBrokerNativeProviderId(value) === null)) {
    return Object.freeze({ state: 'incompatible', readyProviders: [] })
  }
  const socketPath = input.socketPath ?? PROVIDER_BROKER_SOCKET_PATH
  const readyPath = input.readyPath ?? PROVIDER_BROKER_READY_PATH
  const socket = input.port.facts(socketPath)
  const ready = input.port.facts(readyPath)
  if (socket === null && ready === null) {
    return Object.freeze({ state: 'unconfigured', readyProviders: [] })
  }
  if (socket === null || ready === null) {
    return Object.freeze({ state: 'unavailable', readyProviders: [] })
  }
  const inspected = inspectProviderBrokerReady({
    platform: input.platform,
    selectedProviders: [],
    port: input.port,
    expectedInstallationHash: input.expectedInstallationHash,
    socketPath,
    readyPath,
  })
  if (inspected === null) return Object.freeze({ state: 'drifted', readyProviders: [] })
  if (inspected.providers.length === 0) {
    return Object.freeze({ state: 'unconfigured', readyProviders: [] })
  }
  if (input.selectedProviders.some(value => !inspected.providers.includes(value as BrokerNativeProviderId))) {
    return Object.freeze({ state: 'unavailable', readyProviders: inspected.providers })
  }
  return Object.freeze({ state: 'ready', readyProviders: inspected.providers })
}

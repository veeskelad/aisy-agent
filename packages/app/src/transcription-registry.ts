// Pluggable transcription providers (ADR-0085).
//
// Local container and cloud service implement one contract, so adding a
// provider does not touch the voice pipeline. What a provider cannot avoid is
// answering whether the recording leaves the host — that answer is the whole
// point of the registry.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { isProxy } from 'node:util/types'

import type {
  Transcriber,
  TranscriptionAudioRequest,
  TranscriptionTranscript,
} from './transcription-contract.js'

export interface TranscriptionProvider extends Transcriber {
  id: string
  /** Shown to the operator when choosing. */
  label: string
  /** Mandatory: no default, no guessing. A provider that omits it is refused. */
  audioLeavesHost: boolean
  /** Required for external providers and shown verbatim to the operator. */
  privacyDisclosure?: string
  /** Changing external data handling invalidates the previous durable consent. */
  privacyRevision?: string
}

export class TranscriptionUnavailableError extends Error {
  constructor(readonly reason:
    | 'no-provider-selected'
    | 'unknown-provider'
    | 'consent-not-durable'
    | 'invalid-provider-registry') {
    super(`transcription unavailable: ${reason}`)
    this.name = 'TranscriptionUnavailableError'
  }
}

export interface TranscriptionChoice {
  id: string
  label: string
  audioLeavesHost: boolean
  privacyDisclosure?: string
  privacyRevision?: string
  selected: boolean
}

export interface TranscriptionRegistry {
  list(): readonly TranscriptionChoice[]
  selected(): TranscriptionProvider | null
  /** Explicit operator choice. Unknown id is refused, not ignored. */
  select(id: string): TranscriptionChoice
  transcribe(request: TranscriptionAudioRequest): Promise<TranscriptionTranscript>
}

export interface TranscriptionRegistryInspection {
  state: 'ready' | 'unconfigured' | 'quarantined' | 'corrupt'
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const DISCLOSURE_MAX_BYTES = 1024
const MAX_STATE_BYTES = 4096
type PersistResult = 'not-written' | 'committed' | 'durability-ambiguous'

interface TrustedDirectory {
  readonly dev: number
  readonly ino: number
}

function currentUid(): number {
  const uid = process.geteuid?.()
  if (typeof uid !== 'number') throw new Error('unsupported')
  return uid
}

function trustedDirectory(path: string): TrustedDirectory {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) throw new Error('unsafe')
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path ||
    info.uid !== currentUid() || (info.mode & 0o777) !== 0o700) throw new Error('unsafe')
  return Object.freeze({ dev: info.dev, ino: info.ino })
}

function sameDirectory(left: TrustedDirectory, right: TrustedDirectory): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function validStateFile(
  descriptor: number,
  directory: TrustedDirectory,
): ReturnType<typeof fstatSync> {
  const info = fstatSync(descriptor)
  if (!info.isFile() || info.nlink !== 1 || info.dev !== directory.dev ||
    info.uid !== currentUid() || (info.mode & 0o777) !== 0o600 ||
    info.size > MAX_STATE_BYTES) throw new Error('unsafe')
  return info
}

function verifyPublishedState(path: string, directory: TrustedDirectory): void {
  if (!sameDirectory(directory, trustedDirectory(dirname(path)))) throw new Error('unsafe')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { validStateFile(descriptor, directory) } finally { closeSync(descriptor) }
  if (!sameDirectory(directory, trustedDirectory(dirname(path)))) throw new Error('unsafe')
}

function readChoice(path: string): unknown {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('unsupported')
  const directory = trustedDirectory(dirname(path))
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = validStateFile(descriptor, directory)
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8'))
    const after = validStateFile(descriptor, directory)
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      !sameDirectory(directory, trustedDirectory(dirname(path)))) throw new Error('unsafe')
    return parsed
  } finally {
    closeSync(descriptor)
  }
}

function validExternalDisclosure(provider: TranscriptionProvider): boolean {
  if (!provider.audioLeavesHost) return true
  return typeof provider.privacyDisclosure === 'string' &&
    provider.privacyDisclosure.trim() === provider.privacyDisclosure &&
    provider.privacyDisclosure.length > 0 && !provider.privacyDisclosure.includes('\0') &&
    Buffer.byteLength(provider.privacyDisclosure, 'utf8') <= DISCLOSURE_MAX_BYTES &&
    typeof provider.privacyRevision === 'string' && ID.test(provider.privacyRevision)
}

function disclosureHash(provider: TranscriptionProvider): string | null {
  return provider.audioLeavesHost
    ? createHash('sha256')
      .update('aisy.transcription-disclosure.v1\0')
      .update(provider.privacyRevision!)
      .update('\0')
      .update(provider.privacyDisclosure!)
      .digest('hex')
    : null
}

function snapshotProvider(value: TranscriptionProvider): TranscriptionProvider | null {
  if (value === null || typeof value !== 'object' || isProxy(value)) {
    throw new TranscriptionUnavailableError('invalid-provider-registry')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string') ||
    Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
    throw new TranscriptionUnavailableError('invalid-provider-registry')
  }
  const id = descriptors['id']?.value
  const label = descriptors['label']?.value
  const audioLeavesHost = descriptors['audioLeavesHost']?.value
  const privacyDisclosure = descriptors['privacyDisclosure']?.value
  const privacyRevision = descriptors['privacyRevision']?.value
  const transcribe = descriptors['transcribe']?.value
  if (typeof id !== 'string' || !ID.test(id) ||
    typeof label !== 'string' || label.trim() === '' ||
    typeof audioLeavesHost !== 'boolean' || typeof transcribe !== 'function' || isProxy(transcribe)) return null
  const snapshot: TranscriptionProvider = {
    id,
    label,
    audioLeavesHost,
    ...(audioLeavesHost && typeof privacyDisclosure === 'string' && typeof privacyRevision === 'string'
      ? { privacyDisclosure, privacyRevision }
      : {}),
    transcribe: request => transcribe(request),
  }
  if (!validExternalDisclosure(snapshot)) return null
  return Object.freeze(snapshot)
}

interface TranscriptionRegistryDeps {
  providers: readonly TranscriptionProvider[]
  /** Where the operator's choice is stored. */
  path: string
  /** Best-effort observability only; durable state is the consent authority. */
  onSelect?: (choice: TranscriptionChoice) => void
  /** Storage test seam; production uses fsync on the containing directory. */
  syncDirectory?: (path: string) => void
}

function snapshotRegistryDeps(value: TranscriptionRegistryDeps): Readonly<TranscriptionRegistryDeps> {
  if (value === null || typeof value !== 'object' || isProxy(value)) {
    throw new TranscriptionUnavailableError('invalid-provider-registry')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set(['providers', 'path', 'onSelect', 'syncDirectory'])
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key)) ||
    Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
    throw new TranscriptionUnavailableError('invalid-provider-registry')
  }
  const candidates = descriptors['providers']?.value
  const path = descriptors['path']?.value
  const onSelect = descriptors['onSelect']?.value
  const syncDirectory = descriptors['syncDirectory']?.value
  if (!Array.isArray(candidates) || isProxy(candidates) ||
    Object.getPrototypeOf(candidates) !== Array.prototype || candidates.length > 128 ||
    typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0') ||
    (onSelect !== undefined && (typeof onSelect !== 'function' || isProxy(onSelect))) ||
    (syncDirectory !== undefined && (typeof syncDirectory !== 'function' || isProxy(syncDirectory)))) {
    throw new TranscriptionUnavailableError('invalid-provider-registry')
  }
  const candidateDescriptors = Object.getOwnPropertyDescriptors(candidates)
  if (Reflect.ownKeys(candidateDescriptors).some(key => typeof key !== 'string' ||
    (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key))) ||
    Object.values(candidateDescriptors).some(descriptor => !('value' in descriptor)) ||
    Array.from({ length: candidates.length }, (_unused, index) => candidateDescriptors[String(index)])
      .some(descriptor => descriptor === undefined)) {
    throw new TranscriptionUnavailableError('invalid-provider-registry')
  }
  const providers = Array.from(
    { length: candidates.length },
    (_unused, index) => candidateDescriptors[String(index)]!.value as TranscriptionProvider,
  )
  return Object.freeze({
    providers: Object.freeze(providers),
    path,
    ...(onSelect === undefined ? {} : { onSelect }),
    ...(syncDirectory === undefined ? {} : { syncDirectory }),
  })
}

function selectedProviderFromDisk(
  path: string,
  providers: readonly TranscriptionProvider[],
): { state: TranscriptionRegistryInspection['state']; providerId: string | null } {
  const localFallback = providers.find(provider => !provider.audioLeavesHost)?.id ?? null
  if (!existsSync(path)) {
    return localFallback === null
      ? { state: 'unconfigured', providerId: null }
      : { state: 'ready', providerId: localFallback }
  }
  try {
    const raw = readChoice(path)
    const stored = typeof raw === 'object' && raw !== null
      ? raw as Record<string, unknown>
      : null
    const provider = stored?.['schemaVersion'] === 2 && typeof stored['providerId'] === 'string'
      ? providers.find(candidate => candidate.id === stored['providerId'])
      : undefined
    if (provider === undefined || (provider.audioLeavesHost &&
      (stored?.['privacyRevision'] !== provider.privacyRevision ||
        stored?.['privacyDisclosureHash'] !== disclosureHash(provider)))) {
      return { state: 'quarantined', providerId: null }
    }
    return { state: 'ready', providerId: provider.id }
  } catch {
    return { state: 'quarantined', providerId: null }
  }
}

/** Strictly read-only doctor view over the same provider snapshots and durable
 * consent record used by the live registry. */
export function inspectTranscriptionRegistry(
  deps: TranscriptionRegistryDeps,
): TranscriptionRegistryInspection {
  const registryDeps = snapshotRegistryDeps(deps)
  const providers: TranscriptionProvider[] = []
  for (const candidate of registryDeps.providers) {
    const provider = snapshotProvider(candidate)
    if (provider !== null) providers.push(provider)
  }
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) {
    return { state: 'corrupt' }
  }
  return { state: selectedProviderFromDisk(registryDeps.path, providers).state }
}

export function makeTranscriptionRegistry(deps: TranscriptionRegistryDeps): TranscriptionRegistry {
  const registryDeps = snapshotRegistryDeps(deps)
  // A provider that did not answer the question does not get to transcribe.
  const providers: TranscriptionProvider[] = []
  for (const candidate of registryDeps.providers) {
    const provider = snapshotProvider(candidate)
    if (provider !== null) providers.push(provider)
  }
  const providerIds = new Set<string>()
  for (const provider of providers) {
    if (providerIds.has(provider.id)) {
      throw new TranscriptionUnavailableError('invalid-provider-registry')
    }
    providerIds.add(provider.id)
  }
  const byId = new Map(providers.map((provider) => [provider.id, provider]))

  const selection = selectedProviderFromDisk(registryDeps.path, providers)
  // A quarantined external choice still fails closed to the safe local provider;
  // Doctor reports the unsafe durable record separately.
  let selectedId = selection.providerId ??
    providers.find(provider => !provider.audioLeavesHost)?.id ?? null

  const syncDirectory = registryDeps.syncDirectory ?? ((directory: string): void => {
    const descriptor = openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW,
    )
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  })

  const persist = (provider: TranscriptionProvider): PersistResult => {
    let temporary: string | null = null
    let descriptor: number | null = null
    let published = false
    let publishTrusted = false
    try {
      const directory = dirname(registryDeps.path)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (typeof constants.O_NOFOLLOW !== 'number') return 'not-written'
      const anchor = trustedDirectory(directory)
      temporary = `${registryDeps.path}.${randomUUID()}.tmp`
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      writeFileSync(
        descriptor,
        JSON.stringify({
          schemaVersion: 2,
          providerId: provider.id,
          privacyRevision: provider.audioLeavesHost ? provider.privacyRevision! : null,
          privacyDisclosureHash: disclosureHash(provider),
        }, null, 2) + '\n',
        'utf8',
      )
      fsyncSync(descriptor)
      validStateFile(descriptor, anchor)
      closeSync(descriptor)
      descriptor = null
      if (!sameDirectory(anchor, trustedDirectory(directory))) return 'not-written'
      renameSync(temporary, registryDeps.path)
      published = true
      temporary = null
      verifyPublishedState(registryDeps.path, anchor)
      publishTrusted = true
      syncDirectory(directory)
      publishTrusted = false
      verifyPublishedState(registryDeps.path, anchor)
      publishTrusted = true
      return 'committed'
    } catch {
      return published && publishTrusted ? 'durability-ambiguous' : 'not-written'
    } finally {
      if (descriptor !== null) {
        try { closeSync(descriptor) } catch { /* own best-effort cleanup */ }
      }
      if (temporary !== null) {
        try { unlinkSync(temporary) } catch { /* own best-effort cleanup */ }
      }
    }
  }

  const describe = (provider: TranscriptionProvider): TranscriptionChoice => ({
    id: provider.id,
    label: provider.label,
    audioLeavesHost: provider.audioLeavesHost,
    ...(provider.audioLeavesHost
      ? {
          privacyDisclosure: provider.privacyDisclosure!,
          privacyRevision: provider.privacyRevision!,
        }
      : {}),
    selected: provider.id === selectedId,
  })

  return {
    list: () => providers.map(describe),

    selected: () => (selectedId === null ? null : byId.get(selectedId) ?? null),

    select(id) {
      const provider = byId.get(id)
      if (provider === undefined) throw new TranscriptionUnavailableError('unknown-provider')
      if (!provider.audioLeavesHost) {
        // Privacy narrowing fences current egress before fallible persistence.
        selectedId = provider.id
        if (persist(provider) !== 'committed') {
          throw new TranscriptionUnavailableError('consent-not-durable')
        }
        return describe(provider)
      }
      const persisted = persist(provider)
      if (persisted === 'not-written') {
        throw new TranscriptionUnavailableError('consent-not-durable')
      }
      selectedId = provider.id
      const choice = describe(provider)
      if (choice.audioLeavesHost) {
        try {
          registryDeps.onSelect?.(choice)
        } catch { /* the audit line is not worth losing the choice over */ }
      }
      return choice
    },

    async transcribe(request) {
      const provider = selectedId === null ? undefined : byId.get(selectedId)
      // A transcript that never happened is worse than no transcript.
      if (provider === undefined) throw new TranscriptionUnavailableError('no-provider-selected')
      return provider.transcribe(request)
    },
  }
}

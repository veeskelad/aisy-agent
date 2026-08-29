import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'

export interface SessionAutoNameProposalV1 {
  schemaVersion: 1
  projectId: string
  sessionId: string
  turnId: string
  expectedGeneration: number
  expectedLabelRevision: number
  name: string
  state: 'pending-delivery'
  createdAt: string
}

export interface SessionAutoNameStateV1 {
  schemaVersion: 1
  proposals: SessionAutoNameProposalV1[]
}

export interface SessionAutoNameStore {
  get(sessionId: string, turnId: string): SessionAutoNameProposalV1 | null
  put(proposal: SessionAutoNameProposalV1): void
  remove(sessionId: string, turnId: string): void
  removeSession(sessionId: string): void
  clearPending(): number
  snapshot(): SessionAutoNameStateV1
}

export class SessionAutoNameStoreError extends Error {
  constructor(public readonly code: 'CORRUPT_SESSION_AUTO_NAME_STORE') {
    super(code)
    this.name = 'SessionAutoNameStoreError'
  }
}

const SAFE_ID = /^[^\p{Cc}\p{Cf}]{1,256}$/u
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MAX_BYTES = 1024 * 1024
const MAX_PROPOSALS = 1_000

function clone(state: SessionAutoNameStateV1): SessionAutoNameStateV1 {
  return {
    schemaVersion: 1,
    proposals: state.proposals.map((proposal) => ({ ...proposal })),
  }
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && ISO.test(value) && new Date(value).toISOString() === value
}

function validate(value: unknown): SessionAutoNameStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionAutoNameStoreError('CORRUPT_SESSION_AUTO_NAME_STORE')
  }
  const candidate = value as Partial<SessionAutoNameStateV1>
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.proposals) ||
    candidate.proposals.length > MAX_PROPOSALS ||
    Object.keys(candidate).some((key) => !['schemaVersion', 'proposals'].includes(key))) {
    throw new SessionAutoNameStoreError('CORRUPT_SESSION_AUTO_NAME_STORE')
  }
  const keys = new Set<string>()
  for (const raw of candidate.proposals) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SessionAutoNameStoreError('CORRUPT_SESSION_AUTO_NAME_STORE')
    }
    const proposal = raw as Partial<SessionAutoNameProposalV1>
    const key = `${proposal.sessionId ?? ''}\0${proposal.turnId ?? ''}`
    if (proposal.schemaVersion !== 1 || typeof proposal.projectId !== 'string' ||
      !SAFE_ID.test(proposal.projectId) || typeof proposal.sessionId !== 'string' ||
      !SAFE_ID.test(proposal.sessionId) || typeof proposal.turnId !== 'string' ||
      !SAFE_ID.test(proposal.turnId) || !Number.isSafeInteger(proposal.expectedGeneration) ||
      (proposal.expectedGeneration ?? 0) < 1 ||
      !Number.isSafeInteger(proposal.expectedLabelRevision) ||
      (proposal.expectedLabelRevision ?? 0) < 1 || typeof proposal.name !== 'string' ||
      Array.from(proposal.name).length < 1 || Array.from(proposal.name).length > 64 ||
      /[\p{Cc}\p{Cf}<>`]/u.test(proposal.name) || proposal.state !== 'pending-delivery' ||
      !validIso(proposal.createdAt) || keys.has(key) ||
      Object.keys(proposal).some((field) => ![
        'schemaVersion', 'projectId', 'sessionId', 'turnId', 'expectedGeneration',
        'expectedLabelRevision', 'name', 'state', 'createdAt',
      ].includes(field))) {
      throw new SessionAutoNameStoreError('CORRUPT_SESSION_AUTO_NAME_STORE')
    }
    keys.add(key)
  }
  return clone(candidate as SessionAutoNameStateV1)
}

function makeStore(input: {
  initial?: SessionAutoNameStateV1
  save(state: SessionAutoNameStateV1): void
}): SessionAutoNameStore {
  let state = validate(input.initial ?? { schemaVersion: 1, proposals: [] })
  const publish = (candidate: SessionAutoNameStateV1): void => {
    const next = validate(candidate)
    input.save(next)
    state = next
  }
  return Object.freeze<SessionAutoNameStore>({
    get(sessionId, turnId) {
      const proposal = state.proposals.find((item) =>
        item.sessionId === sessionId && item.turnId === turnId)
      return proposal === undefined ? null : { ...proposal }
    },
    put(proposal) {
      const withoutSession = state.proposals.filter((item) => item.sessionId !== proposal.sessionId)
      publish({ schemaVersion: 1, proposals: [...withoutSession, { ...proposal }] })
    },
    remove(sessionId, turnId) {
      if (!state.proposals.some((item) => item.sessionId === sessionId && item.turnId === turnId)) return
      publish({
        schemaVersion: 1,
        proposals: state.proposals.filter((item) =>
          item.sessionId !== sessionId || item.turnId !== turnId),
      })
    },
    removeSession(sessionId) {
      if (!state.proposals.some((item) => item.sessionId === sessionId)) return
      publish({
        schemaVersion: 1,
        proposals: state.proposals.filter((item) => item.sessionId !== sessionId),
      })
    },
    clearPending() {
      const cleared = state.proposals.length
      if (cleared > 0) publish({ schemaVersion: 1, proposals: [] })
      return cleared
    },
    snapshot: () => clone(state),
  })
}

export function makeMemorySessionAutoNameStore(input: {
  initial?: SessionAutoNameStateV1
  save?: (state: SessionAutoNameStateV1) => void
} = {}): SessionAutoNameStore {
  return makeStore({
    ...(input.initial === undefined ? {} : { initial: input.initial }),
    save: input.save ?? (() => undefined),
  })
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeSessionAutoNameStore(input: { path: string }): SessionAutoNameStore {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const orphanPattern = new RegExp(
    `^${basename(input.path).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.tmp-\\d+-` +
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    'u',
  )
  for (const entry of readdirSync(directory)) {
    if (orphanPattern.test(entry)) unlinkSync(`${directory}/${entry}`)
  }
  let initial: SessionAutoNameStateV1 = { schemaVersion: 1, proposals: [] }
  if (existsSync(input.path)) {
    const raw = readFileSync(input.path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
      throw new SessionAutoNameStoreError('CORRUPT_SESSION_AUTO_NAME_STORE')
    }
    try {
      initial = validate(JSON.parse(raw) as unknown)
    } catch (error) {
      if (error instanceof SessionAutoNameStoreError) throw error
      throw new SessionAutoNameStoreError('CORRUPT_SESSION_AUTO_NAME_STORE')
    }
  }
  return makeStore({
    initial,
    save: (state) => {
      const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
      try {
        writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
          encoding: 'utf8', flag: 'wx', mode: 0o600,
        })
        syncPath(temporary)
        renameSync(temporary, input.path)
        syncPath(directory)
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    },
  })
}

/** Optional metadata must never make the conversational gateway unavailable. */
export function recoverSessionAutoNameStore(
  open: () => SessionAutoNameStore,
): SessionAutoNameStore | null {
  try {
    const store = open()
    store.clearPending()
    return store
  } catch {
    return null
  }
}

/**
 * Pending names are optional and have no delivery authority after restart.
 * Retiring the whole canonical file is therefore the only safe self-heal for
 * corrupt or ambiguous bytes; if even that cannot be made durable, callers
 * receive null and Session deletion must remain unavailable.
 */
export function recoverNodeSessionAutoNameStore(input: { path: string }): SessionAutoNameStore | null {
  const open = (): SessionAutoNameStore => makeNodeSessionAutoNameStore(input)
  const recovered = recoverSessionAutoNameStore(open)
  if (recovered !== null) return recovered
  try {
    if (existsSync(input.path)) unlinkSync(input.path)
    syncPath(dirname(input.path))
    return open()
  } catch {
    return null
  }
}

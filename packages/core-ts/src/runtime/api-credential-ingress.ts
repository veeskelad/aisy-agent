import { createHash } from 'node:crypto'

import type { BrainValidationResult } from '../onboarding/brain-connections.js'
import type {
  ApiCredentialBinding,
  ApiCredentialBroker,
  ApiCredentialEntryChallenge,
} from './api-key-setup-driver.js'

export type ApiCredentialIngressStatus =
  | 'issued'
  | 'committing'
  | 'ready'
  | 'failed'
  | 'revoked'

interface ApiCredentialRecordBase extends ApiCredentialBinding {
  id: string
  status: ApiCredentialIngressStatus
  issuedAt: string
  expiresAt: string
  updatedAt: string
}

export interface ApiCredentialIssuedRecord extends ApiCredentialRecordBase {
  status: 'issued'
  codeHash: string
}

export interface ApiCredentialCommittingRecord extends ApiCredentialRecordBase {
  status: 'committing'
}

export interface ApiCredentialTerminalRecord extends ApiCredentialRecordBase {
  status: 'ready' | 'failed' | 'revoked'
  lastErrorCode?: string
}

export type ApiCredentialIngressRecord =
  | ApiCredentialIssuedRecord
  | ApiCredentialCommittingRecord
  | ApiCredentialTerminalRecord

export interface ApiCredentialIngressStore {
  issue(record: ApiCredentialIssuedRecord): Promise<void>
  claim(codeHash: string, nowIso: string): Promise<ApiCredentialCommittingRecord | null>
  current(binding: ApiCredentialBinding): Promise<ApiCredentialIngressRecord | null>
  markReady(id: string, nowIso: string): Promise<boolean>
  markFailed(id: string, errorCode: string, nowIso: string): Promise<boolean>
  markRevoked(binding: ApiCredentialBinding, nowIso: string): Promise<boolean>
}

/**
 * Transactional vault boundary. Secret bytes enter only `stage` and cannot be
 * read back. Provider validation resolves a staged/active handle outside the
 * agent loop. `activeTransactionId` is safe metadata used for crash recovery.
 */
export interface ApiCredentialVaultTransactions {
  stage(vaultKey: string, transactionId: string, secret: Uint8Array): Promise<void>
  hasStaged(vaultKey: string, transactionId: string): Promise<boolean>
  activate(vaultKey: string, transactionId: string): Promise<void>
  discard(vaultKey: string, transactionId: string): Promise<void>
  activeTransactionId(vaultKey: string): Promise<string | null>
  deleteActive(vaultKey: string): Promise<void>
}

export interface ApiCredentialProviderValidator {
  validateStaged(binding: ApiCredentialBinding, transactionId: string): Promise<BrainValidationResult>
  validateActive(binding: ApiCredentialBinding): Promise<BrainValidationResult>
}

export interface ApiCredentialIngress extends ApiCredentialBroker {
  /** Takes ownership of `secret` and zeroes it before returning. */
  submit(entryCode: string, secret: Uint8Array): Promise<BrainValidationResult>
  recover(binding: ApiCredentialBinding): Promise<BrainValidationResult>
}

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const VAULT_KEY = /^AISY_PROVIDER_[A-Z0-9_]{1,96}_KEY$/
const ENTRY_CODE = /^[A-Za-z0-9_-]{16,32}$/
const HASH = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const MIN_SECRET_BYTES = 8
const MAX_SECRET_BYTES = 16 * 1024

function validBinding(value: ApiCredentialBinding): boolean {
  return ID.test(value.connectionId) && ID.test(value.provider) && VAULT_KEY.test(value.vaultKey)
}

function sameBinding(left: ApiCredentialBinding, right: ApiCredentialBinding): boolean {
  return left.connectionId === right.connectionId && left.provider === right.provider &&
    left.vaultKey === right.vaultKey
}

function safeCode(value: string | undefined, fallback: string): string {
  return value !== undefined && ERROR_CODE.test(value) ? value : fallback
}

function safeResult(ok: boolean, safeDetail: string, errorCode?: string): BrainValidationResult {
  return ok
    ? { ok: true, safeDetail }
    : { ok: false, safeDetail, errorCode: safeCode(errorCode, 'API_CREDENTIAL_FAILED') }
}

function validSecret(secret: Uint8Array): boolean {
  if (secret.byteLength < MIN_SECRET_BYTES || secret.byteLength > MAX_SECRET_BYTES) return false
  for (const byte of secret) {
    if (byte === 0 || byte === 10 || byte === 13) return false
  }
  return true
}

function hashCode(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function makeApiCredentialIngress(input: {
  store: ApiCredentialIngressStore
  vault: ApiCredentialVaultTransactions
  validator: ApiCredentialProviderValidator
  nowMs(): number
  newId(): string
  newEntryCode(): string
  ttlMs?: number
}): ApiCredentialIngress {
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60 * 1000) {
    throw new Error('INVALID_API_CREDENTIAL_TTL')
  }

  const now = (): { ms: number; iso: string } => {
    const ms = input.nowMs()
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('INVALID_API_CREDENTIAL_CLOCK')
    return { ms, iso: new Date(ms).toISOString() }
  }

  const failTransaction = async (
    record: ApiCredentialCommittingRecord,
    errorCode: string,
  ): Promise<BrainValidationResult> => {
    const finalCode = safeCode(errorCode, 'API_CREDENTIAL_FAILED')
    try {
      await input.vault.discard(record.vaultKey, record.id)
    } catch {
      // Keep the durable record `committing`: recovery must retain authority
      // to retry cleanup of staged secret material.
      return safeResult(false, 'API credential rollback requires recovery.',
        'API_CREDENTIAL_ROLLBACK_FAILED')
    }
    try {
      await input.store.markFailed(record.id, finalCode, now().iso)
    } catch {
      return safeResult(false, 'API credential state requires recovery.',
        'API_CREDENTIAL_STATE_FAILED')
    }
    return safeResult(false, 'API credential was not activated.', finalCode)
  }

  const finish = async (
    record: ApiCredentialCommittingRecord,
  ): Promise<BrainValidationResult> => {
    let result: BrainValidationResult
    try {
      result = await input.validator.validateStaged(record, record.id)
    } catch {
      return failTransaction(record, 'API_CREDENTIAL_VALIDATION_FAILED')
    }
    if (!result.ok) {
      return failTransaction(record, safeCode(result.errorCode, 'API_CREDENTIAL_REJECTED'))
    }
    try {
      await input.vault.activate(record.vaultKey, record.id)
    } catch {
      return failTransaction(record, 'API_CREDENTIAL_ACTIVATION_FAILED')
    }
    try {
      if (await input.store.markReady(record.id, now().iso)) {
        return safeResult(true, 'API credential is validated and active.')
      }
    } catch {
      // The active transaction id is durable recovery evidence. Keep the
      // record committing instead of deleting a successfully activated key.
    }
    return safeResult(false, 'API credential state could not be published.', 'API_CREDENTIAL_STATE_FAILED')
  }

  const validateReady = async (binding: ApiCredentialBinding): Promise<BrainValidationResult> => {
    const record = await input.store.current(binding)
    if (record === null || record.status !== 'ready' || !sameBinding(record, binding) ||
      await input.vault.activeTransactionId(record.vaultKey) !== record.id) {
      return safeResult(false, 'API credential is not ready.', 'API_CREDENTIAL_NOT_READY')
    }
    try {
      const result = await input.validator.validateActive(binding)
      return result.ok
        ? safeResult(true, 'API credential is healthy.')
        : safeResult(false, 'API credential validation failed.',
            safeCode(result.errorCode, 'API_CREDENTIAL_VALIDATION_FAILED'))
    } catch {
      return safeResult(false, 'API credential validation failed.', 'API_CREDENTIAL_VALIDATION_FAILED')
    }
  }

  return Object.freeze<ApiCredentialIngress>({
    async issue(binding): Promise<ApiCredentialEntryChallenge> {
      if (!validBinding(binding)) throw new Error('INVALID_API_CREDENTIAL_BINDING')
      const prior = await input.store.current(binding)
      if (prior?.status === 'committing') {
        try {
          await input.vault.discard(prior.vaultKey, prior.id)
        } catch {
          throw new Error('API_CREDENTIAL_PENDING_ROLLBACK_FAILED')
        }
      }
      const id = input.newId()
      const entryCode = input.newEntryCode()
      const timestamp = now()
      if (!ID.test(id) || !ENTRY_CODE.test(entryCode)) {
        throw new Error('INVALID_API_CREDENTIAL_CHALLENGE')
      }
      const expiresAt = new Date(timestamp.ms + ttlMs).toISOString()
      const codeHash = hashCode(entryCode)
      if (!HASH.test(codeHash)) throw new Error('INVALID_API_CREDENTIAL_CHALLENGE')
      await input.store.issue({
        ...binding,
        id,
        status: 'issued',
        codeHash,
        issuedAt: timestamp.iso,
        expiresAt,
        updatedAt: timestamp.iso,
      })
      return { entryCode, expiresAt }
    },

    async submit(entryCode, secret): Promise<BrainValidationResult> {
      try {
        if (!ENTRY_CODE.test(entryCode) || !validSecret(secret)) {
          return safeResult(false, 'Credential entry was rejected.', 'API_CREDENTIAL_INPUT_REJECTED')
        }
        const timestamp = now()
        const claimed = await input.store.claim(hashCode(entryCode), timestamp.iso)
        if (claimed === null || Date.parse(claimed.expiresAt) <= timestamp.ms) {
          return safeResult(false, 'Credential challenge is invalid or expired.', 'API_CREDENTIAL_CHALLENGE_REJECTED')
        }
        try {
          await input.vault.stage(claimed.vaultKey, claimed.id, secret)
        } catch {
          return failTransaction(claimed, 'API_CREDENTIAL_STAGE_FAILED')
        }
        return finish(claimed)
      } finally {
        secret.fill(0)
      }
    },

    async recover(binding): Promise<BrainValidationResult> {
      if (!validBinding(binding)) throw new Error('INVALID_API_CREDENTIAL_BINDING')
      const record = await input.store.current(binding)
      if (record === null || !sameBinding(record, binding)) {
        return safeResult(false, 'API credential is not configured.', 'API_CREDENTIAL_NOT_FOUND')
      }
      if (record.status === 'ready') {
        const activeId = await input.vault.activeTransactionId(record.vaultKey)
        return activeId === record.id
          ? validateReady(binding)
          : safeResult(false, 'API credential state is inconsistent.', 'API_CREDENTIAL_STATE_FAILED')
      }
      if (record.status !== 'committing') {
        return safeResult(false, 'API credential is not ready.', 'API_CREDENTIAL_NOT_READY')
      }
      const activeId = await input.vault.activeTransactionId(record.vaultKey)
      if (activeId === record.id) {
        return await input.store.markReady(record.id, now().iso)
          ? safeResult(true, 'API credential activation was recovered.')
          : safeResult(false, 'API credential state could not be recovered.', 'API_CREDENTIAL_STATE_FAILED')
      }
      if (!await input.vault.hasStaged(record.vaultKey, record.id)) {
        return failTransaction(record, 'API_CREDENTIAL_STAGE_MISSING')
      }
      return finish(record)
    },

    async validate(binding): Promise<BrainValidationResult> {
      if (!validBinding(binding)) throw new Error('INVALID_API_CREDENTIAL_BINDING')
      return validateReady(binding)
    },

    async revoke(binding): Promise<BrainValidationResult> {
      if (!validBinding(binding)) throw new Error('INVALID_API_CREDENTIAL_BINDING')
      const record = await input.store.current(binding)
      if (record?.status === 'committing') {
        try {
          await input.vault.discard(record.vaultKey, record.id)
        } catch {
          return safeResult(false, 'Pending API credential could not be revoked.',
            'API_CREDENTIAL_REVOKE_FAILED')
        }
      }
      try {
        await input.vault.deleteActive(binding.vaultKey)
      } catch {
        return safeResult(false, 'API credential could not be revoked.', 'API_CREDENTIAL_REVOKE_FAILED')
      }
      try {
        return await input.store.markRevoked(binding, now().iso)
          ? safeResult(true, 'API credential was revoked.')
          : safeResult(false, 'API credential state could not be revoked.', 'API_CREDENTIAL_STATE_FAILED')
      } catch {
        return safeResult(false, 'API credential state could not be revoked.', 'API_CREDENTIAL_STATE_FAILED')
      }
    },
  })
}

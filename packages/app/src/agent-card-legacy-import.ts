import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'

import type { ConfinementErrorCode, ConfinementProcessPort } from '@aisy/core'

const MAX_CARD_BYTES = 64 * 1024
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const RESPONSE_CODES = new Set<ConfinementErrorCode>([
  'INVALID_REQUEST',
  'INVALID_PATH',
  'SYMLINK_DENIED',
  'SPECIAL_FILE_DENIED',
  'HARDLINK_DENIED',
  'CROSS_DEVICE_DENIED',
  'LIMIT_EXCEEDED',
  'NOT_FOUND',
  'NOT_DIRECTORY',
  'NOT_REGULAR',
  'PATH_CHANGED',
  'PRECONDITION_FAILED',
  'AMBIGUOUS_MATCH',
  'UTF8_REQUIRED',
  'IO_FAILED',
  'UNSUPPORTED_PLATFORM',
  'INTERNAL_ERROR',
])

export type AgentCardLegacyImportErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_ROOT'
  | 'PROCESS_FAILED'
  | 'PROTOCOL_ERROR'
  | ConfinementErrorCode

export class AgentCardLegacyImportError extends Error {
  constructor(readonly code: AgentCardLegacyImportErrorCode) {
    super(code)
    this.name = 'AgentCardLegacyImportError'
  }
}

export interface AgentCardLegacyImportPort {
  readExact(name: string): Promise<string>
}

function exactValues(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length !== keys.length) return null
    const allowed = new Set(keys)
    const out: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!allowed.has(key) || !('value' in descriptor)) return null
      out[key] = descriptor.value
    }
    return out
  } catch {
    return null
  }
}

function trustedRoot(value: string): Readonly<{ path: string; device: string; inode: string }> {
  try {
    if (!isAbsolute(value) || normalize(value) !== value || realpathSync(value) !== value) {
      throw new AgentCardLegacyImportError('INVALID_ROOT')
    }
    const info = lstatSync(value, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AgentCardLegacyImportError('INVALID_ROOT')
    }
    return Object.freeze({ path: value, device: info.dev.toString(), inode: info.ino.toString() })
  } catch (error) {
    if (error instanceof AgentCardLegacyImportError) throw error
    throw new AgentCardLegacyImportError('INVALID_ROOT')
  }
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 1024) {
    throw new AgentCardLegacyImportError('INVALID_REQUEST')
  }
  return value
}

function parseResponse(response: unknown, expectedRequestId: string): string {
  const success = exactValues(response, ['version', 'requestId', 'ok', 'data'])
  if (success !== null && success['version'] === 1 && success['requestId'] === expectedRequestId &&
    success['ok'] === true) {
    const data = exactValues(success['data'], ['text', 'bytes'])
    if (!data || typeof data['text'] !== 'string' || !Number.isSafeInteger(data['bytes']) ||
      (data['bytes'] as number) < 0 || (data['bytes'] as number) > MAX_CARD_BYTES ||
      Buffer.byteLength(data['text'], 'utf8') !== data['bytes']) {
      throw new AgentCardLegacyImportError('PROTOCOL_ERROR')
    }
    return data['text']
  }

  const denied = exactValues(response, ['version', 'requestId', 'ok', 'error'])
  if (denied !== null && denied['version'] === 1 && denied['requestId'] === expectedRequestId &&
    denied['ok'] === false) {
    const error = exactValues(denied['error'], ['code'])
    if (error && typeof error['code'] === 'string' &&
      RESPONSE_CODES.has(error['code'] as ConfinementErrorCode)) {
      throw new AgentCardLegacyImportError(error['code'] as ConfinementErrorCode)
    }
  }
  throw new AgentCardLegacyImportError('PROTOCOL_ERROR')
}

export function makeAgentCardLegacyImportPort(input: {
  root: string
  process: ConfinementProcessPort
  newId: () => string
}): AgentCardLegacyImportPort {
  const root = trustedRoot(input.root)
  return Object.freeze({
    async readExact(name: string): Promise<string> {
      if (!NAME.test(name) || name === 'general') {
        throw new AgentCardLegacyImportError('INVALID_NAME')
      }
      let id: string
      try {
        id = requestId(input.newId())
      } catch (error) {
        if (error instanceof AgentCardLegacyImportError) throw error
        throw new AgentCardLegacyImportError('INVALID_REQUEST')
      }
      let response: unknown
      try {
        response = await input.process.run({
          version: 1,
          requestId: id,
          root: root.path,
          op: 'read',
          path: `${name}.md`,
          maxBytes: MAX_CARD_BYTES,
          expectedRootDevice: root.device,
          expectedRootInode: root.inode,
        })
      } catch {
        throw new AgentCardLegacyImportError('PROCESS_FAILED')
      }
      return parseResponse(response, id)
    },
  })
}

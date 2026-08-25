import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import type { ToolExecutionContext } from '../agent-loop/types.js'

const MAX_FACT_BYTES = 4_096
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/u
const RESERVED_PREFIX = /^(?:remember:|memory\.remember\/|запомнил(?:а)?(?:\s|,|:|$)|факт сохран[её]н(?:\s|:|$))/iu

export interface MemoryRememberReceiptV1 {
  readonly kind: 'memory.remember/v1'
  readonly operationId: string
  readonly receiptId: string
  readonly turnId: string
  readonly fact: string
  readonly committed: true
}

export type VerifiedToolMutationReceipt = MemoryRememberReceiptV1

export type RememberFactInput = Readonly<{
  fact: string
  topic?: string
}>

function digest(domain: string, fields: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update(domain)
  for (const field of fields) hash.update('\0').update(field)
  return hash.digest('hex')
}

export function parseRememberFactArgs(args: Readonly<Record<string, unknown>>):
RememberFactInput | null {
  const hasFact = Object.hasOwn(args, 'fact')
  const hasText = Object.hasOwn(args, 'text')
  if (hasFact === hasText) return null
  const value = hasFact ? args['fact'] : args['text']
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_FACT_BYTES || CONTROL_CHAR.test(value) ||
    RESERVED_PREFIX.test(value)) return null
  const topic = args['topic']
  if (topic !== undefined && (typeof topic !== 'string' || topic.length === 0 ||
    topic !== topic.trim() || Buffer.byteLength(topic, 'utf8') > 128 ||
    CONTROL_CHAR.test(topic))) return null
  return Object.freeze({ fact: value, ...(topic === undefined ? {} : { topic }) })
}

export function makeMemoryRememberReceipt(
  input: RememberFactInput,
  context: ToolExecutionContext | undefined,
): MemoryRememberReceiptV1 | null {
  if (context === undefined || context.turnId === undefined || context.turnId.length === 0 ||
    context.sessionId.length === 0 || !Number.isSafeInteger(context.ordinal) || context.ordinal < 1) {
    return null
  }
  const operationId = digest('aisy-memory-remember-operation/v1', [
    context.sessionId,
    context.turnId,
    String(context.ordinal),
  ])
  return Object.freeze({
    kind: 'memory.remember/v1',
    operationId,
    receiptId: digest('aisy-memory-remember-receipt/v1', [operationId, input.fact]),
    turnId: context.turnId,
    fact: input.fact,
    committed: true,
  })
}

export function renderMemoryAcknowledgement(fact: string): string {
  return `Запомнил, что ${fact}`
}

export function parseMemoryRememberReceipt(value: unknown): MemoryRememberReceiptV1 | null {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const keys = Object.keys(descriptors)
  const expected = ['kind', 'operationId', 'receiptId', 'turnId', 'fact', 'committed']
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(descriptors, key))) {
    return null
  }
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) return null
  }
  const raw = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
  if (raw['kind'] !== 'memory.remember/v1' || raw['committed'] !== true ||
    typeof raw['operationId'] !== 'string' || !/^[a-f0-9]{64}$/u.test(raw['operationId']) ||
    typeof raw['receiptId'] !== 'string' || !/^[a-f0-9]{64}$/u.test(raw['receiptId']) ||
    typeof raw['turnId'] !== 'string' || raw['turnId'].length === 0 ||
    typeof raw['fact'] !== 'string') return null
  const parsed = parseRememberFactArgs({ fact: raw['fact'] })
  if (parsed === null) return null
  const expectedReceiptId = digest('aisy-memory-remember-receipt/v1', [
    raw['operationId'],
    parsed.fact,
  ])
  if (raw['receiptId'] !== expectedReceiptId) return null
  return Object.freeze({
    kind: 'memory.remember/v1',
    operationId: raw['operationId'],
    receiptId: raw['receiptId'],
    turnId: raw['turnId'],
    fact: parsed.fact,
    committed: true,
  })
}

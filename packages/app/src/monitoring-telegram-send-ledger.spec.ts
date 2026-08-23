import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeNodeMonitoringTelegramSendLedger,
  MonitoringTelegramSendLedgerError,
} from './monitoring-telegram-send-ledger.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aisy-monitoring-telegram-ledger-'))
  roots.push(root)
  return { root, path: join(root, 'delivery.json') }
}

describe('monitoring Telegram send ledger', () => {
  it('caches a positive receipt and recovers it after restart without another send', async () => {
    const h = setup()
    const transport = vi.fn(async () => ({ messageId: 501 }))
    const first = makeNodeMonitoringTelegramSendLedger({ path: h.path, newTempId: () => 'first' })
    await expect(first.send({
      idempotencyKey: 'digest-1', chatId: 42, html: '<b>digest</b>', transport,
    })).resolves.toEqual({ messageId: 501 })

    const restarted = makeNodeMonitoringTelegramSendLedger({ path: h.path, newTempId: () => 'second' })
    await expect(restarted.send({
      idempotencyKey: 'digest-1', chatId: 42, html: '<b>digest</b>', transport,
    })).resolves.toEqual({ messageId: 501 })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(statSync(h.path).mode & 0o777).toBe(0o600)
  })

  it('fails closed after an ambiguous transport result and never repeats the same key', async () => {
    const h = setup()
    const acceptedThenLost = vi.fn(async () => { throw new Error('connection lost after accept') })
    const first = makeNodeMonitoringTelegramSendLedger({ path: h.path, newTempId: () => 'first' })
    await expect(first.send({
      idempotencyKey: 'digest-1', chatId: 42, html: 'digest', transport: acceptedThenLost,
    })).rejects.toThrow('connection lost after accept')

    const mustNotSend = vi.fn(async () => ({ messageId: 502 }))
    const restarted = makeNodeMonitoringTelegramSendLedger({ path: h.path, newTempId: () => 'second' })
    await expect(restarted.send({
      idempotencyKey: 'digest-1', chatId: 42, html: 'digest', transport: mustNotSend,
    })).rejects.toThrowError(expect.objectContaining<Partial<MonitoringTelegramSendLedgerError>>({
      code: 'AMBIGUOUS_SEND',
    }))
    expect(acceptedThenLost).toHaveBeenCalledTimes(1)
    expect(mustNotSend).not.toHaveBeenCalled()
  })

  it('rejects key reuse with a different payload or route', async () => {
    const h = setup()
    const ledger = makeNodeMonitoringTelegramSendLedger({ path: h.path, newTempId: () => 'one' })
    await ledger.send({
      idempotencyKey: 'digest-1', chatId: 42, html: 'digest',
      transport: async () => ({ messageId: 501 }),
    })
    await expect(ledger.send({
      idempotencyKey: 'digest-1', chatId: 43, html: 'digest',
      transport: async () => ({ messageId: 502 }),
    })).rejects.toThrowError(expect.objectContaining<Partial<MonitoringTelegramSendLedgerError>>({
      code: 'PAYLOAD_MISMATCH',
    }))
  })

  it('rejects corrupt or expanded state instead of resetting delivery history', () => {
    const h = setup()
    writeFileSync(h.path, JSON.stringify({ schemaVersion: 1, entries: [], extra: true }))
    expect(() => makeNodeMonitoringTelegramSendLedger({ path: h.path }))
      .toThrowError(expect.objectContaining<Partial<MonitoringTelegramSendLedgerError>>({
        code: 'INVALID_STATE',
      }))
    expect(readFileSync(h.path, 'utf8')).toContain('"extra":true')
  })
})

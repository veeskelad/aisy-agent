import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')

describe('monitoring LIVE production composition', () => {
  it('wires no-tools scoring, exact source controls, bounded scheduler and Telegram delivery', () => {
    expect(production).toContain("cfg('AISY_MONITORING') !== '0'")
    expect(production).toMatch(/makeProviderMonitoringScorer\(\{[\s\S]{0,220}adapterFor\([^\n]+, \[\]\)/)
    expect(production).toContain('makeTelegramMonitoringControls({')
    expect(production).toContain('makeMonitoringLiveCoordinator({')
    expect(production).toContain('makeMonitoringDeliveryCoordinator({')
    expect(production).toContain('makeTelegramMonitoringDigestDeliveryPort({')
    expect(production).toContain('makeNodeMonitoringTelegramSendLedger({')
    expect(production).toContain("join(base, 'monitoring-telegram-delivery.json')")
    expect(production).toContain('...(tickMonitoring === undefined ? {} : { tickMonitoring })')
  })

  it('guards the exact payload before the only Telegram digest send', () => {
    const guard = production.indexOf('await gateway.streamReply(allowedChatId, exactPayload())')
    const send = production.indexOf('const sent = await bot.api.sendMessage(chatId, html')
    expect(guard).toBeGreaterThan(0)
    expect(send).toBeGreaterThan(guard)
    expect(production.slice(guard, send)).not.toContain('fetch(')
  })

  it('keeps the rollback flag code-owned and never mutates it from Telegram', () => {
    expect(production).not.toMatch(/process\.env\[['"]AISY_MONITORING['"]\]\s*=(?!=)/)
  })

  it('fences the Telegram transport with the stable digest id before send', () => {
    const output = production.indexOf('async sendMessage({ chatId, html, idempotencyKey })')
    const ledger = production.indexOf('return monitoringTelegramSendLedger.send({', output)
    const transport = production.indexOf('const sent = await bot.api.sendMessage(chatId, html', ledger)
    expect(output).toBeGreaterThan(0)
    expect(ledger).toBeGreaterThan(output)
    expect(transport).toBeGreaterThan(ledger)
    expect(production.slice(ledger, transport)).toContain('idempotencyKey,')
  })
})

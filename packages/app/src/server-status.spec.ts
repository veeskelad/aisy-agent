import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'

import { readServerStatus, renderServerStatus, type ServerStatus } from './server-status.js'

describe('server status (plan 11.9)', () => {
  it('reports live numbers for a real directory', () => {
    const status = readServerStatus({ root: tmpdir(), version: '0.1.14' })

    expect(status.version).toBe('0.1.14')
    expect(status.memory.totalBytes).toBeGreaterThan(0)
    expect(status.memory.usedShare).toBeGreaterThanOrEqual(0)
    expect(status.memory.usedShare).toBeLessThanOrEqual(1)
    expect(status.disk?.totalBytes ?? 0).toBeGreaterThan(0)
  })

  it('leaves the disk null rather than reporting a fabricated zero', () => {
    const status = readServerStatus({
      root: '/definitely/not/a/path/aisy-test',
      version: '0.1.14',
    })

    // A fabricated zero would read as "the disk is full" and trigger exactly
    // the wrong reaction.
    expect(status.disk).toBeNull()
    expect(renderServerStatus(status)).toContain('измерить не удалось')
  })

  it('rounds uptime rather than showing a fractional second', () => {
    const status = readServerStatus({
      root: tmpdir(),
      version: '0.1.14',
      processUptimeSec: () => 125.7,
      hostUptimeSec: () => 5_400.4,
    })

    expect(status.processUptimeSec).toBe(126)
    expect(status.hostUptimeSec).toBe(5_400)
    expect(readServerStatus({
      root: tmpdir(),
      version: '0.1.14',
      hostUptimeSec: () => -5,
    }).hostUptimeSec).toBe(0)
  })

  it.each([
    ['throws', () => { throw new Error('EPERM') }],
    ['returns NaN', () => Number.NaN],
    ['returns Infinity', () => Number.POSITIVE_INFINITY],
  ])('reports host uptime as unavailable when measuring it %s', (_label, measure) => {
    const status = readServerStatus({
      root: tmpdir(),
      version: '0.1.14',
      hostUptimeSec: measure,
    })

    expect(status.hostUptimeSec).toBeNull()
    expect(renderServerStatus(status)).toContain('Хост живёт: измерить не удалось')
  })

  it('renders a panel an operator can read at a glance', () => {
    const status: ServerStatus = {
      processUptimeSec: 3 * 86_400 + 5 * 3_600,
      hostUptimeSec: 90 * 60,
      memory: { totalBytes: 8 * 1024 ** 3, freeBytes: 2 * 1024 ** 3, usedShare: 0.75 },
      disk: { totalBytes: 100 * 1024 ** 3, freeBytes: 40 * 1024 ** 3, usedShare: 0.6 },
      version: '0.1.14',
      nodeVersion: 'v22.0.0',
    }

    const text = renderServerStatus(status)

    expect(text).toContain('3 д 5 ч')
    expect(text).toContain('1 ч 30 мин')
    expect(text).toContain('75 %')
    expect(text).toContain('60 %')
    expect(text).toContain('0.1.14')
  })

  it('never reports a share outside 0…1, even on nonsense input', () => {
    const status: ServerStatus = {
      processUptimeSec: -5,
      hostUptimeSec: 0,
      memory: { totalBytes: 0, freeBytes: 0, usedShare: 0 },
      disk: null,
      version: 'dev',
      nodeVersion: 'v22.0.0',
    }

    expect(renderServerStatus(status)).toContain('0 %')
    expect(readServerStatus({ root: tmpdir(), version: 'dev', processUptimeSec: () => -5 })
      .processUptimeSec).toBe(0)
  })
})

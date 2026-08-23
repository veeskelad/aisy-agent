import { describe, expect, it } from 'vitest'
import { ConfinementError, type ConfinementWorkerRequest } from '@aisy/core'
import { makeConfinementTreeScanner } from './confinement-tree-scanner.js'

describe('makeConfinementTreeScanner', () => {
  it('scans the exact code-owned staging root with bounded protocol fields', async () => {
    const requests: ConfinementWorkerRequest[] = []
    const scanner = makeConfinementTreeScanner({
      newId: () => 'scan-1',
      process: {
        run: async (request) => {
          requests.push(request)
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: { entries: 8, files: 3, directories: 5, totalBytes: 256 },
          }
        },
      },
    })

    await expect(scanner.scanRoot('/srv/aisy/.aisy-staging-1', {
      maxEntries: 100,
      maxDepth: 8,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    })).resolves.toEqual({ entries: 8, files: 3, directories: 5, totalBytes: 256 })
    expect(requests).toEqual([{
      version: 1,
      requestId: 'scan-1',
      root: '/srv/aisy/.aisy-staging-1',
      op: 'scan',
      path: '.',
      maxEntries: 100,
      maxDepth: 8,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    }])
  })

  it('preserves known worker denials without leaking response details', async () => {
    const scanner = makeConfinementTreeScanner({
      newId: () => 'scan-1',
      process: {
        run: async () => ({
          version: 1,
          requestId: 'scan-1',
          ok: false,
          error: { code: 'CROSS_DEVICE_DENIED', detail: '/private/mount' },
        }),
      },
    })

    await expect(scanner.scanRoot('/staging')).rejects.toEqual(
      new ConfinementError('CROSS_DEVICE_DENIED'),
    )
  })

  it.each([
    { version: 1, requestId: 'wrong', ok: true, data: {} },
    { version: 1, requestId: 'scan-1', ok: false, error: { code: 'UNKNOWN' } },
    { version: 1, requestId: 'scan-1', ok: true, data: { entries: -1 } },
  ])('rejects malformed worker responses', async (response) => {
    const scanner = makeConfinementTreeScanner({
      newId: () => 'scan-1',
      process: { run: async () => response },
    })

    await expect(scanner.scanRoot('/staging')).rejects.toEqual(
      new ConfinementError('PROTOCOL_ERROR'),
    )
  })
})

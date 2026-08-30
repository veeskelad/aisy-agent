import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeMediaRecoveryRetentionPort } from './media-recovery-retention-sidecar.js'
import {
  compactMediaInboxWriterRecoveryArchives,
  inspectMediaInboxWriterLock,
  makeMediaInboxWriterRecovery,
  MediaInboxWriterRecoveryError,
  unattendedRecoveryAuthorization,
} from './telegram-attachment-inbox-recovery.js'
import { makeSingletonTelegramAttachmentInbox } from './telegram-attachment-inbox.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function script(source: string, name = 'worker.mjs'): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-media-retention-process-'))
  roots.push(root)
  const path = join(root, name)
  writeFileSync(path, source, { mode: 0o700 })
  return path
}

const seal = Object.freeze({
  version: 1 as const,
  rootDevice: '1',
  rootInode: '2',
  lockDevice: '1',
  lockInode: '3',
  ownerDevice: '1',
  ownerInode: '4',
  ownerFingerprint: `sha256:${'a'.repeat(64)}`,
})

describe('makeNodeMediaRecoveryRetentionPort', () => {
  it('uses a no-shell one-shot protocol and returns only bounded counters', () => {
    const workerPath = script(`
      import { readFileSync } from 'node:fs'
      const input = JSON.parse(readFileSync(0, 'utf8'))
      if (process.env.PRIVATE_TOKEN !== undefined) process.exit(9)
      if ('reservedRecoverySlot' in input) process.exit(8)
      process.stdout.write(JSON.stringify({
        version: 1,
        requestId: input.requestId,
        ok: true,
        data: { removed: 57, retained: 8 },
      }))
    `, 'worker ; literal.mjs')
    const port = makeNodeMediaRecoveryRetentionPort({
      pythonExecutable: process.execPath,
      workerPath,
    })

    expect(port.compact({ inboxRoot: '/tmp/media-inbox', seal }))
      .toEqual({ removed: 57, retained: 8 })
  })

  it.each([
    ['PATH_CHANGED', 'STATE_CORRUPT'],
    ['UNSUPPORTED_PLATFORM', 'UNSUPPORTED_PLATFORM'],
    ['INTERNAL_ERROR', 'RECOVERY_INCOMPLETE'],
  ] as const)('maps redacted worker error %s to %s', (workerCode, expected) => {
    const workerPath = script(`
      import { readFileSync } from 'node:fs'
      const input = JSON.parse(readFileSync(0, 'utf8'))
      process.stdout.write(JSON.stringify({
        version: 1,
        requestId: input.requestId,
        ok: false,
        error: { code: '${workerCode}' },
      }))
      process.exitCode = 2
    `)
    const port = makeNodeMediaRecoveryRetentionPort({
      pythonExecutable: process.execPath,
      workerPath,
    })

    expect(() => port.compact({ inboxRoot: '/tmp/media-inbox', seal }))
      .toThrow(new MediaInboxWriterRecoveryError(expected))
  })

  it.each([
    "process.stdout.write('not-json')",
    "process.stdout.write(JSON.stringify({version:1,requestId:'wrong',ok:true,data:{removed:0,retained:0}}))",
    "process.stdout.write(JSON.stringify({version:1,requestId:'wrong',ok:true,data:{removed:0,retained:9}}))",
    'process.exitCode = 7',
  ])('fails closed for malformed process output', (source) => {
    const port = makeNodeMediaRecoveryRetentionPort({
      pythonExecutable: process.execPath,
      workerPath: script(source),
    })
    expect(() => port.compact({ inboxRoot: '/tmp/media-inbox', seal }))
      .toThrow(new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE'))
  })

  it('requires canonical absolute code-owned paths and a valid seal', () => {
    expect(() => makeNodeMediaRecoveryRetentionPort({
      pythonExecutable: 'python3',
      workerPath: '/opt/aisy/worker.py',
    })).toThrow(new MediaInboxWriterRecoveryError('INVALID_REQUEST'))
    const port = makeNodeMediaRecoveryRetentionPort({
      pythonExecutable: process.execPath,
      workerPath: script(''),
    })
    expect(() => port.compact({
      inboxRoot: '/tmp/media-inbox',
      seal: { ...seal, ownerInode: '01' },
    })).toThrow(new MediaInboxWriterRecoveryError('INVALID_REQUEST'))
  })
})

const pythonExecutable = resolve(process.cwd(), '../sidecars-py/.venv/bin/python')
const realWorkerPath = resolve(
  process.cwd(),
  '../sidecars-py/aisy_sidecars/confinement_worker.py',
)

describe.runIf(existsSync(pythonExecutable) && existsSync(realWorkerPath))(
  'Node to Python media retention integration',
  () => {
    it('repairs the real 65-archive production boundary under an exact writer seal', () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-media-retention-integration-')))
      roots.push(root)
      const singleton = makeSingletonTelegramAttachmentInbox({
        inboxRoot: root,
        allowedChatId: 42,
        maxAttachmentBytes: 1024,
        download: { async download() { throw new Error('unused') } },
        nowIso: () => '2026-08-30T00:00:00.000Z',
        newNonce: () => 'live-writer',
        pid: 42,
      })
      const archiveRoot = join(root, '.writer-lock-recovery')
      mkdirSync(archiveRoot, { mode: 0o700 })
      for (let index = 0; index < 65; index += 1) {
        const entry = join(archiveRoot, `recovery-fixture-${String(index).padStart(3, '0')}`)
        mkdirSync(entry, { mode: 0o700 })
        writeFileSync(join(entry, 'owner.json'), JSON.stringify({
          version: 1,
          pid: 1000 + index,
          nonce: `archive-${index}`,
          acquiredAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
        }) + '\n', { mode: 0o600 })
      }

      const result = compactMediaInboxWriterRecoveryArchives({
        inboxRoot: root,
        writer: singleton.maintenance,
        retention: makeNodeMediaRecoveryRetentionPort({
          pythonExecutable,
          workerPath: realWorkerPath,
        }),
      })

      expect(result).toEqual({ removed: 57, retained: 8 })
      expect(readdirSync(archiveRoot)).toHaveLength(8)
      expect(existsSync(join(root, '.writer-lock-gc'))).toBe(false)
      singleton.close()
    }, 15_000)

    it('compacts the full ceiling before archiving a dead writer', () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-media-retention-ceiling-')))
      roots.push(root)
      makeSingletonTelegramAttachmentInbox({
        inboxRoot: root,
        allowedChatId: 42,
        maxAttachmentBytes: 1024,
        download: { async download() { throw new Error('unused') } },
        nowIso: () => '2026-08-30T00:00:00.000Z',
        newNonce: () => 'dead-writer',
        pid: 42,
      })
      const archiveRoot = join(root, '.writer-lock-recovery')
      mkdirSync(archiveRoot, { mode: 0o700 })
      for (let index = 0; index < 256; index += 1) {
        const entry = join(archiveRoot, `recovery-ceiling-${String(index).padStart(3, '0')}`)
        mkdirSync(entry, { mode: 0o700 })
        writeFileSync(join(entry, 'owner.json'), JSON.stringify({
          version: 1,
          pid: 2000 + index,
          nonce: `archive-${index}`,
          acquiredAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
        }) + '\n', { mode: 0o600 })
      }
      const finding = inspectMediaInboxWriterLock({ inboxRoot: root })
      if (finding.state !== 'held') throw new Error('fixture lock missing')
      const recovery = makeMediaInboxWriterRecovery({
        inboxRoot: root,
        authorization: unattendedRecoveryAuthorization,
        quiescence: {
          acquire: () => ({ assertHeld: () => true, release: () => undefined }),
        },
        newId: () => 'dead-writer',
      })
      const retention = makeNodeMediaRecoveryRetentionPort({
        pythonExecutable,
        workerPath: realWorkerPath,
      })

      expect(recovery.compactArchives({
        expectedOwnerFingerprint: finding.ownerFingerprint,
        retention,
      })).toEqual({ removed: 248, retained: 8 })
      recovery.archive({
        expectedOwnerFingerprint: finding.ownerFingerprint,
        approval: null,
      })
      expect(readdirSync(archiveRoot)).toHaveLength(9)

      const restarted = makeSingletonTelegramAttachmentInbox({
        inboxRoot: root,
        allowedChatId: 42,
        maxAttachmentBytes: 1024,
        download: { async download() { throw new Error('unused') } },
        nowIso: () => '2026-08-30T00:01:00.000Z',
        newNonce: () => 'restarted-writer',
        pid: 43,
      })
      expect(compactMediaInboxWriterRecoveryArchives({
        inboxRoot: root,
        writer: restarted.maintenance,
        retention,
      })).toEqual({ removed: 1, retained: 8 })
      expect(readdirSync(archiveRoot)).toHaveLength(8)
      restarted.close()
    }, 30_000)
  },
)

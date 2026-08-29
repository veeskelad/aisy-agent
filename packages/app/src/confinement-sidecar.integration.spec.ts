import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfinementError,
  makeConfinementPort,
  makeContextLeaseCoordinator,
} from '@aisy/core'
import { makeNodeConfinementProcessPort } from './confinement-sidecar.js'

const pythonExecutable = resolve(process.cwd(), '../sidecars-py/.venv/bin/python')
const workerPath = resolve(
  process.cwd(),
  '../sidecars-py/aisy_sidecars/confinement_worker.py',
)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.runIf(existsSync(pythonExecutable) && existsSync(workerPath))(
  'Node to Python confinement integration',
  () => {
    it('performs real descriptor-relative I/O and denies a symlink escape', async () => {
      const root = mkdtempSync(join(tmpdir(), 'aisy-confinement-integration-'))
      roots.push(root)
      const outside = mkdtempSync(join(tmpdir(), 'aisy-confinement-outside-'))
      roots.push(outside)
      writeFileSync(join(root, 'hello.txt'), 'Привет', 'utf8')
      writeFileSync(join(root, 'notes.txt'), 'alpha beta alpha', 'utf8')
      writeFileSync(join(outside, 'private.txt'), 'outside', 'utf8')
      symlinkSync(outside, join(root, 'escape'), 'dir')

      let id = 0
      const leases = makeContextLeaseCoordinator({ newId: () => `id-${++id}` })
      const lease = leases.acquire({
        operatorId: 'telegram:42',
        profileId: 'default',
        projectId: 'project-a',
        projectKind: 'project',
        sessionId: 'session-a',
        root,
        generation: 1,
      })
      const confinement = makeConfinementPort({
        leases,
        process: makeNodeConfinementProcessPort({ pythonExecutable, workerPath }),
        newId: () => `request-${++id}`,
      })

      await expect(confinement.readText(lease, 'hello.txt')).resolves.toBe('Привет')
      await expect(confinement.writeText(lease, 'result.txt', 'готово')).resolves.toBe(12)
      await expect(confinement.editText(
        lease,
        'notes.txt',
        'alpha',
        'gamma',
      )).rejects.toEqual(new ConfinementError('AMBIGUOUS_MATCH'))
      await expect(confinement.editText(
        lease,
        'notes.txt',
        'alpha',
        'gamma',
        { replaceAll: true },
      )).resolves.toEqual({ bytes: 16, replacements: 2 })
      await expect(confinement.readText(lease, 'notes.txt')).resolves.toBe('gamma beta gamma')
      await expect(confinement.list(lease)).resolves.toEqual([
        'escape', 'hello.txt', 'notes.txt', 'result.txt',
      ])
      await expect(confinement.scan(lease)).rejects.toEqual(
        new ConfinementError('SYMLINK_DENIED'),
      )
      await expect(confinement.readText(lease, 'escape/private.txt')).rejects.toEqual(
        new ConfinementError('SYMLINK_DENIED'),
      )
      await expect(confinement.editText(
        lease,
        'escape/private.txt',
        'outside',
        'changed',
      )).rejects.toEqual(new ConfinementError('SYMLINK_DENIED'))
    }, 15_000)

    it('denies a real-directory swap after policy admission', async () => {
      const root = mkdtempSync(join(tmpdir(), 'aisy-confinement-swap-'))
      roots.push(root)
      mkdirSync(join(root, 'open'))
      mkdirSync(join(root, 'strict'))
      writeFileSync(join(root, 'open', 'data.txt'), 'open', 'utf8')
      writeFileSync(join(root, 'strict', 'data.txt'), 'strict', 'utf8')
      const rootInfo = lstatSync(root, { bigint: true })
      const openInfo = lstatSync(join(root, 'open'), { bigint: true })
      const fileInfo = lstatSync(join(root, 'open', 'data.txt'), { bigint: true })
      const pin = {
        rootDevice: rootInfo.dev.toString(10),
        rootInode: rootInfo.ino.toString(10),
        components: [
          { name: 'open', device: openInfo.dev.toString(10), inode: openInfo.ino.toString(10) },
          {
            name: 'data.txt',
            device: fileInfo.dev.toString(10),
            inode: fileInfo.ino.toString(10),
          },
        ],
      }
      renameSync(join(root, 'open'), join(root, 'open-old'))
      renameSync(join(root, 'strict'), join(root, 'open'))

      let id = 0
      const leases = makeContextLeaseCoordinator({ newId: () => `swap-${++id}` })
      const lease = leases.acquire({
        operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
        projectKind: 'project', sessionId: 'session-a', root, generation: 1,
      })
      const confinement = makeConfinementPort({
        leases,
        process: makeNodeConfinementProcessPort({ pythonExecutable, workerPath }),
        newId: () => `request-${++id}`,
      })

      await expect(confinement.writeText(lease, 'open/data.txt', 'changed', undefined, pin))
        .rejects.toEqual(new ConfinementError('PATH_CHANGED'))
      expect(readFileSync(join(root, 'open', 'data.txt'), 'utf8')).toBe('strict')
      expect(readFileSync(join(root, 'open-old', 'data.txt'), 'utf8')).toBe('open')
    }, 15_000)
  },
)

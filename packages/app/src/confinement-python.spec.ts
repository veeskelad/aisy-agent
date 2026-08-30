import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  selectConfinementPython,
  verifyManagedConfinementPrerequisite,
  type ManagedConfinementPrerequisitePorts,
} from './confinement-python.js'

const RELEASE = 'a'.repeat(40)
const PREREQUISITE_ROOT = '/managed/releases/' + RELEASE + '/packages/sidecars-py'
const PREREQUISITE_WORKER = PREREQUISITE_ROOT + '/aisy_sidecars/confinement_worker.py'

function managedFixture(): {
  root: string
  releaseSidecars: string
  activeSidecars: string
  projectInterpreter: string
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-managed-python-')))
  const release = join(root, 'releases', RELEASE)
  const releaseSidecars = join(release, 'packages', 'sidecars-py')
  const generation = join(root, 'generations', 'g-aaaaaaaaaaaaaaaa')
  const active = join(root, 'active')
  mkdirSync(releaseSidecars, { recursive: true })
  mkdirSync(join(root, 'repository.git'))
  mkdirSync(generation, { recursive: true })
  symlinkSync(join('..', '..', 'releases', RELEASE), join(generation, 'current'))
  symlinkSync(join('generations', 'g-aaaaaaaaaaaaaaaa'), active)
  return {
    root,
    releaseSidecars,
    activeSidecars: join(active, 'current', 'packages', 'sidecars-py'),
    projectInterpreter: join(root, 'project-python', 'bin', 'python'),
  }
}

describe('selectConfinementPython', () => {
  it('uses the fixed system interpreter for an immutable managed release', () => {
    const value = managedFixture()

    expect(selectConfinementPython({
      sidecarsRoot: value.releaseSidecars,
      projectInterpreter: value.projectInterpreter,
    })).toBe('/usr/bin/python3.12')
  })

  it('canonicalizes the active symlink before classifying a managed release', () => {
    const value = managedFixture()

    expect(selectConfinementPython({
      sidecarsRoot: value.activeSidecars,
      projectInterpreter: value.projectInterpreter,
    })).toBe('/usr/bin/python3.12')
  })

  it('keeps the project interpreter for a local source checkout', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-source-python-')))
    const sidecarsRoot = join(root, 'packages', 'sidecars-py')
    const projectInterpreter = join(root, 'project-python', 'bin', 'python')
    mkdirSync(sidecarsRoot, { recursive: true })

    expect(selectConfinementPython({ sidecarsRoot, projectInterpreter }))
      .toBe(projectInterpreter)
  })

  it('does not trust a deceptive managed-looking suffix without active authority', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-fake-managed-python-')))
    const sidecarsRoot = join(root, 'releases', RELEASE, 'packages', 'sidecars-py')
    const projectInterpreter = join(root, 'project-python', 'bin', 'python')
    mkdirSync(sidecarsRoot, { recursive: true })

    expect(selectConfinementPython({ sidecarsRoot, projectInterpreter }))
      .toBe(projectInterpreter)
  })
})

function prerequisitePorts(input: {
  python?: 'trusted' | 'missing' | 'unsafe'
  response?: 'valid' | 'wrong' | 'wrong-version'
} = {}): ManagedConfinementPrerequisitePorts {
  const python = input.python ?? 'trusted'
  const response = input.response ?? 'valid'
  return {
    effectiveUid: () => 501,
    inspect: path => {
      if (path === '/usr/bin/python3.12') {
        if (python === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return {
          kind: 'file', symbolicLink: python === 'unsafe', uid: 0,
          mode: python === 'unsafe' ? 0o777 : 0o755, nlink: 1, realpath: path,
        }
      }
      if (path === '/' || path === '/usr' || path === '/usr/bin') {
        return {
          kind: 'directory', symbolicLink: false, uid: 0,
          mode: 0o755, nlink: 1, realpath: path,
        }
      }
      if (path.endsWith('/confinement_worker.py')) {
        return {
          kind: 'file', symbolicLink: false, uid: 501,
          mode: 0o600, nlink: 1, realpath: path,
        }
      }
      return {
        kind: 'directory', symbolicLink: false, uid: 501,
        mode: 0o700, nlink: 1, realpath: path,
      }
    },
    run: request => {
      const decoded = JSON.parse(request.stdin) as Record<string, unknown>
      const exact = request.executable === '/usr/bin/python3.12' &&
        request.args.join('\0') === ['-I', PREREQUISITE_WORKER].join('\0') &&
        request.cwd === PREREQUISITE_ROOT &&
        Object.keys(request.environment).sort().join(',') ===
          'LANG,LC_ALL,PATH,PYTHONDONTWRITEBYTECODE' &&
        decoded['version'] === 1 &&
        decoded['requestId'] === 'managed-confinement-prerequisite' &&
        decoded['root'] === PREREQUISITE_ROOT && decoded['op'] === 'runtime-probe'
      if (!exact || response === 'wrong') {
        return { status: 0, signal: null, stdout: '{}\n', stderr: '' }
      }
      return {
          status: 0, signal: null, stdout: JSON.stringify({
            version: 1,
            requestId: 'managed-confinement-prerequisite',
            ok: true,
            data: {
              pythonMajor: 3,
              pythonMinor: response === 'wrong-version' ? 11 : 12,
              confinement: true,
            },
          }) + '\n', stderr: '',
        }
    },
  }
}

describe('verifyManagedConfinementPrerequisite', () => {
  it('accepts a root-owned fixed Python only after a real worker protocol smoke', () => {
    expect(() => verifyManagedConfinementPrerequisite(
      { sidecarsRoot: PREREQUISITE_ROOT, workerPath: PREREQUISITE_WORKER },
      prerequisitePorts(),
    )).not.toThrow()
  })

  it('refuses a missing or unsafe fixed interpreter before running the worker', () => {
    for (const python of ['missing', 'unsafe'] as const) {
      let runs = 0
      const ports = prerequisitePorts({ python })
      expect(() => verifyManagedConfinementPrerequisite(
        { sidecarsRoot: PREREQUISITE_ROOT, workerPath: PREREQUISITE_WORKER },
        { ...ports, run: request => {
          runs++
          return ports.run(request)
        } },
      )).toThrow('CONFINEMENT_PREREQUISITE_REFUSED')
      expect(runs).toBe(0)
    }
  })

  it('refuses a wrong Python version or non-exact isolated protocol envelope', () => {
    for (const response of ['wrong-version', 'wrong'] as const) {
      expect(() => verifyManagedConfinementPrerequisite(
        { sidecarsRoot: PREREQUISITE_ROOT, workerPath: PREREQUISITE_WORKER },
        prerequisitePorts({ response }),
      )).toThrow('CONFINEMENT_PREREQUISITE_REFUSED')
    }
  })
})

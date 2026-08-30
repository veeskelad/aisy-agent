import { spawnSync } from 'node:child_process'
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const GENERATION = /^g-[a-f0-9]{16,64}$/
const SYSTEM_PYTHON = '/usr/bin/python3.12'

export interface ManagedConfinementPathInspection {
  readonly kind: 'file' | 'directory' | 'other'
  readonly symbolicLink: boolean
  readonly uid: number
  readonly mode: number
  readonly nlink: number
  readonly realpath: string
}

export interface ManagedConfinementRunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

export interface ManagedConfinementPrerequisitePorts {
  readonly effectiveUid: () => number
  readonly inspect: (path: string) => ManagedConfinementPathInspection
  readonly run: (input: {
    readonly executable: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly stdin: string
    readonly environment: Readonly<Record<string, string>>
  }) => ManagedConfinementRunResult
}

export function nodeManagedConfinementPrerequisitePorts(): ManagedConfinementPrerequisitePorts {
  return {
    effectiveUid: () => process.geteuid?.() ?? 0,
    inspect: path => {
      const info = lstatSync(path)
      return Object.freeze({
        kind: info.isFile() ? 'file' as const
          : info.isDirectory() ? 'directory' as const
            : 'other' as const,
        symbolicLink: info.isSymbolicLink(),
        uid: info.uid,
        mode: info.mode & 0o777,
        nlink: info.nlink,
        realpath: realpathSync(path),
      })
    },
    run: input => {
      const child = spawnSync(input.executable, [...input.args], {
        cwd: input.cwd,
        env: { ...input.environment },
        input: input.stdin,
        encoding: 'utf8',
        shell: false,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      })
      return Object.freeze({
        status: child.status,
        signal: child.signal,
        stdout: typeof child.stdout === 'string' ? child.stdout : '',
        stderr: typeof child.stderr === 'string' ? child.stderr : '',
        ...(child.error === undefined ? {} : { error: child.error }),
      })
    },
  }
}

function isCurrentManagedRelease(sidecarsRoot: string): boolean {
  try {
    const packagesRoot = dirname(sidecarsRoot)
    const releaseRoot = dirname(packagesRoot)
    const releasesRoot = dirname(releaseRoot)
    const installRoot = dirname(releasesRoot)
    if (
      basename(sidecarsRoot) !== 'sidecars-py' ||
      basename(packagesRoot) !== 'packages' ||
      !COMMIT.test(basename(releaseRoot)) ||
      basename(releasesRoot) !== 'releases'
    ) return false
    for (const path of [
      installRoot,
      join(installRoot, 'repository.git'),
      releasesRoot,
      join(installRoot, 'generations'),
    ]) {
      const info = lstatSync(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
    }
    const activePath = join(installRoot, 'active')
    const activeInfo = lstatSync(activePath)
    if (!activeInfo.isSymbolicLink()) return false
    const activeTarget = readlinkSync(activePath)
    const prefix = `generations/`
    if (!activeTarget.startsWith(prefix) ||
      !GENERATION.test(activeTarget.slice(prefix.length))) return false
    const generationRoot = join(installRoot, activeTarget)
    const generationInfo = lstatSync(generationRoot)
    if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) return false
    const currentPath = join(generationRoot, 'current')
    const currentInfo = lstatSync(currentPath)
    if (!currentInfo.isSymbolicLink() ||
      readlinkSync(currentPath) !== join('..', '..', 'releases', basename(releaseRoot))) {
      return false
    }
    return realpathSync(currentPath) === releaseRoot
  } catch {
    return false
  }
}

export function selectConfinementPython(input: {
  readonly sidecarsRoot: string
  readonly projectInterpreter: string
}): string {
  const sidecarsRoot = realpathSync(input.sidecarsRoot)
  if (isCurrentManagedRelease(sidecarsRoot)) return SYSTEM_PYTHON
  return input.projectInterpreter
}

export function verifyManagedConfinementPrerequisite(
  input: { readonly sidecarsRoot: string; readonly workerPath: string },
  ports: ManagedConfinementPrerequisitePorts = nodeManagedConfinementPrerequisitePorts(),
): void {
  const refuse = (): never => { throw new Error('CONFINEMENT_PREREQUISITE_REFUSED') }
  try {
    if (!isAbsolute(input.sidecarsRoot) || resolve(input.sidecarsRoot) !== input.sidecarsRoot ||
      input.workerPath !== join(
        input.sidecarsRoot, 'aisy_sidecars', 'confinement_worker.py',
      )) refuse()
    const uid = ports.effectiveUid()
    if (!Number.isSafeInteger(uid) || uid <= 0) refuse()
    for (const path of ['/', '/usr', '/usr/bin']) {
      const info = ports.inspect(path)
      if (info.kind !== 'directory' || info.symbolicLink || info.uid !== 0 ||
        (info.mode & 0o022) !== 0 || info.realpath !== path) refuse()
    }
    const python = ports.inspect(SYSTEM_PYTHON)
    if (python.kind !== 'file' || python.symbolicLink || python.uid !== 0 ||
      python.nlink !== 1 || (python.mode & 0o022) !== 0 ||
      (python.mode & 0o111) === 0 || python.realpath !== SYSTEM_PYTHON) refuse()
    const sidecars = ports.inspect(input.sidecarsRoot)
    if (sidecars.kind !== 'directory' || sidecars.symbolicLink || sidecars.uid !== uid ||
      (sidecars.mode & 0o022) !== 0 || sidecars.realpath !== input.sidecarsRoot) refuse()
    const worker = ports.inspect(input.workerPath)
    if (worker.kind !== 'file' || worker.symbolicLink || worker.uid !== uid ||
      worker.nlink !== 1 || (worker.mode & 0o022) !== 0 ||
      worker.realpath !== input.workerPath) refuse()
    const requestId = 'managed-confinement-prerequisite'
    const result = ports.run({
      executable: SYSTEM_PYTHON,
      args: ['-I', input.workerPath],
      cwd: input.sidecarsRoot,
      stdin: JSON.stringify({
        version: 1,
        requestId,
        root: input.sidecarsRoot,
        op: 'runtime-probe',
      }),
      environment: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    })
    if (result.error !== undefined || result.status !== 0 || result.signal !== null ||
      Buffer.byteLength(result.stdout, 'utf8') > 64 * 1024 ||
      Buffer.byteLength(result.stderr, 'utf8') > 16 * 1024 || result.stderr !== '') refuse()
    const response: unknown = JSON.parse(result.stdout)
    if (typeof response !== 'object' || response === null || Array.isArray(response)) refuse()
    const envelope = response as Record<string, unknown>
    if (Object.keys(envelope).sort().join(',') !== 'data,ok,requestId,version' ||
      envelope['version'] !== 1 || envelope['requestId'] !== requestId ||
      envelope['ok'] !== true) refuse()
    const data = envelope['data']
    if (typeof data !== 'object' || data === null || Array.isArray(data)) refuse()
    const probe = data as Record<string, unknown>
    if (Object.keys(probe).sort().join(',') !== 'confinement,pythonMajor,pythonMinor' ||
      probe['pythonMajor'] !== 3 || probe['pythonMinor'] !== 12 ||
      probe['confinement'] !== true) refuse()
  } catch (error) {
    if (error instanceof Error && error.message === 'CONFINEMENT_PREREQUISITE_REFUSED') {
      throw error
    }
    refuse()
  }
}

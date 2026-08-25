import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bootstrapManagedInstall,
  cleanupManagedInstall,
  ManagedUpdateFailure,
  nodeManagedUpdatePorts,
  rollbackManagedInstall,
  resumeManagedAutoSkillsAfterRollForward,
  recordManagedReleaseIntegrity,
  refuseGitLfsPointers,
  runManagedUpdateCli,
  updateManagedInstall,
  verifyManagedReleaseIntegrity,
  type ManagedUpdatePorts,
} from './managed-install.js'
import {
  makeNodeAutoSkillStoreV2,
  prepareNodeAutoSkillRollback,
} from './auto-skill-store.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const roots: string[] = []

interface Fixture {
  root: string
  binDir: string
  target: string
  ancestor: boolean
  prepared: string[]
  removed: string[]
  verified: string[]
  fetched: number
  faultAt: Set<string>
  failVerify: Set<string>
  autoSkillRollback: 'absent' | 'safe' | 'drifted'
  rollbackPrepared: string[]
  rollbackVerified: string[]
  generation: number
  ports: ManagedUpdatePorts
}

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(path)
  return path
}

function gitTree(content: string): { root: string; commit: string } {
  const root = directory('aisy-git-tree-')
  const source = join(root, 'source')
  mkdirSync(join(root, 'repository.git'), { mode: 0o700 })
  mkdirSync(source, { mode: 0o700 })
  execFileSync('git', ['init', '--bare', join(root, 'repository.git')], { stdio: 'ignore' })
  execFileSync('git', ['init'], { cwd: source, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Aisy Test'], { cwd: source })
  execFileSync('git', ['config', 'user.email', 'aisy-test@example.invalid'], { cwd: source })
  writeFileSync(join(source, 'fixture.txt'), content)
  execFileSync('git', ['add', 'fixture.txt'], { cwd: source })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: source, stdio: 'ignore' })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  execFileSync('git', [
    `--git-dir=${join(root, 'repository.git')}`, 'fetch', source, `${commit}:refs/heads/master`,
  ], { stdio: 'ignore' })
  return { root, commit }
}

function fixture(initial = A): Fixture {
  const root = directory('aisy-managed-')
  const binDir = join(root, 'bin')
  mkdirSync(join(root, 'repository.git'), { mode: 0o700 })
  mkdirSync(join(root, 'releases'), { mode: 0o700 })
  mkdirSync(join(root, 'generations'), { mode: 0o700 })
  mkdirSync(binDir, { mode: 0o700 })
  mkdirSync(join(root, 'releases', initial), { mode: 0o700 })
  const value: Fixture = {
    root,
    binDir,
    target: B,
    ancestor: true,
    prepared: [],
    removed: [],
    verified: [],
    fetched: 0,
    faultAt: new Set(),
    failVerify: new Set(),
    autoSkillRollback: 'absent',
    rollbackPrepared: [],
    rollbackVerified: [],
    generation: 0,
    ports: undefined as unknown as ManagedUpdatePorts,
  }
  value.ports = {
    effectiveUid: () => process.getuid?.() ?? 501,
    fetchHead: () => { value.fetched++; return value.target },
    isAncestor: () => value.ancestor,
    prepareRelease: (_root, commit) => {
      value.prepared.push(commit)
      const path = join(root, 'releases', commit)
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
    },
    verifyRelease: (_root, commit) => {
      value.verified.push(commit)
      if (value.failVerify.has(commit)) throw new Error('doctor')
    },
    prepareAutoSkillRollback: (targetCommit) => {
      value.rollbackPrepared.push(targetCommit)
      if (value.autoSkillRollback === 'drifted') {
        throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
      }
      return value.autoSkillRollback === 'absent'
        ? { kind: 'state-absent' }
        : { kind: 'rollback-safe', certificateId: 'c'.repeat(64) }
    },
    verifyAutoSkillRollback: (targetCommit) => {
      value.rollbackVerified.push(targetCommit)
      if (value.autoSkillRollback === 'drifted') {
        throw new ManagedUpdateFailure('UPDATE_STATE_REFUSED')
      }
    },
    removeRelease: (_root, commit) => {
      value.removed.push(commit)
      rmSync(join(root, 'releases', commit), { recursive: true })
    },
    pruneWorktrees: () => undefined,
    withOperationLock: (_root, body) => body(),
    generationId: () => (++value.generation).toString(16).padStart(16, '0'),
    fault: point => {
      if (value.faultAt.delete(point)) throw new Error(`fault:${point}`)
    },
  }
  return value
}

function bootstrap(value: Fixture): void {
  bootstrapManagedInstall({ root: value.root, binDir: value.binDir, commit: A }, value.ports)
}

function activeLinks(value: Fixture): { current: string; previous: string | null } {
  const generation = join(value.root, readlinkSync(join(value.root, 'active')))
  const current = readlinkSync(join(generation, 'current')).split('/').at(-1) as string
  const previousPath = join(generation, 'previous')
  return {
    current,
    previous: existsSync(previousPath)
      ? readlinkSync(previousPath).split('/').at(-1) as string
      : null,
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('managed Git distribution', () => {
  it('publishes a durable auto-skill write barrier bound to the certified state hash', () => {
    const home = directory('aisy-managed-state-')
    const previousHome = process.env['AISY_HOME']
    process.env['AISY_HOME'] = home
    try {
      const ports = nodeManagedUpdatePorts()
      const certified = ports.prepareAutoSkillRollback(A)
      expect(certified.kind).toBe('rollback-safe')
      expect(existsSync(join(home, 'auto-skills-v2', 'rollback-barrier-v1.json'))).toBe(true)
      expect(() => makeNodeAutoSkillStoreV2({ root: join(home, 'auto-skills-v2') }))
        .toThrowError('AUTO_SKILL_ROLLBACK_BARRIER')
      expect(() => ports.verifyAutoSkillRollback(A, certified)).not.toThrow()
      writeFileSync(join(home, 'auto-skills-v2', 'state-v2.json'), '{}\n', { mode: 0o600 })
      expect(() => ports.verifyAutoSkillRollback(A, certified))
        .toThrowError(expect.objectContaining({ code: 'UPDATE_STATE_REFUSED' }))
    } finally {
      if (previousHome === undefined) delete process.env['AISY_HOME']
      else process.env['AISY_HOME'] = previousHome
    }
  })

  it('lets only the active v2-aware managed release resume writes after roll-forward', () => {
    const value = fixture()
    bootstrap(value)
    const autoSkillRoot = directory('aisy-managed-auto-skill-')
    makeNodeAutoSkillStoreV2({ root: autoSkillRoot })
    prepareNodeAutoSkillRollback({ root: autoSkillRoot, targetCommit: B })

    expect(() => resumeManagedAutoSkillsAfterRollForward({
      root: value.root,
      binDir: value.binDir,
      autoSkillRoot,
      currentCommit: B,
    }, value.ports)).toThrowError(expect.objectContaining({ code: 'UPDATE_STATE_REFUSED' }))
    expect(() => makeNodeAutoSkillStoreV2({ root: autoSkillRoot }))
      .toThrowError('AUTO_SKILL_ROLLBACK_BARRIER')

    expect(resumeManagedAutoSkillsAfterRollForward({
      root: value.root,
      binDir: value.binDir,
      autoSkillRoot,
      currentCommit: A,
    }, value.ports)).toMatchObject({ current: A })
    expect(makeNodeAutoSkillStoreV2({ root: autoSkillRoot }).doctor().active).toBe(0)
  })

  it.runIf(existsSync('/usr/bin/flock'))(
    'forces a private umask for the complete kernel-locked operation',
    () => {
      const root = directory('aisy-managed-umask-')
      const created = join(root, 'created-under-lock')
      const original = process.umask(0o002)

      try {
        nodeManagedUpdatePorts().withOperationLock(root, () => {
          mkdirSync(created)
          expect(lstatSync(created).mode & 0o777).toBe(0o700)
        })
        expect(process.umask()).toBe(0o002)
      } finally {
        process.umask(original)
      }
    },
  )

  it('batch-scans Git objects and refuses LFS pointers with extension lines', () => {
    const clean = gitTree('ordinary small blob\n')
    expect(() => refuseGitLfsPointers(clean.root, clean.commit)).not.toThrow()

    const lfs = gitTree(
      'version https://git-lfs.github.com/spec/v1\next-0 example:value\n',
    )
    expect(() => refuseGitLfsPointers(lfs.root, lfs.commit)).toThrow()
  })

  it('converges missing and partial Git worktree removal residues', () => {
    const missing = gitTree('missing worktree\n')
    const missingPath = join(missing.root, 'releases', missing.commit)
    mkdirSync(join(missing.root, 'releases'), { mode: 0o700 })
    execFileSync('/usr/bin/git', [
      `--git-dir=${join(missing.root, 'repository.git')}`,
      'worktree', 'add', '--detach', missingPath, missing.commit,
    ], { stdio: 'ignore' })
    rmSync(missingPath, { recursive: true })
    nodeManagedUpdatePorts().pruneWorktrees(missing.root)
    expect(() => execFileSync('/usr/bin/git', [
      `--git-dir=${join(missing.root, 'repository.git')}`,
      'worktree', 'add', '--detach', missingPath, missing.commit,
    ], { stdio: 'ignore' })).not.toThrow()

    const partial = gitTree('partial worktree\n')
    const partialPath = join(partial.root, 'releases', partial.commit)
    mkdirSync(join(partial.root, 'releases'), { mode: 0o700 })
    execFileSync('/usr/bin/git', [
      `--git-dir=${join(partial.root, 'repository.git')}`,
      'worktree', 'add', '--detach', partialPath, partial.commit,
    ], { stdio: 'ignore' })
    unlinkSync(join(partialPath, 'fixture.txt'))
    nodeManagedUpdatePorts().removeRelease(partial.root, partial.commit)
    expect(existsSync(partialPath)).toBe(false)
  })

  it.each(['post-head', 'pre-head', 'missing'] as const)(
    'removes a real locked initializing worktree residue at %s',
    phase => {
      const value = gitTree(`locked ${phase}\n`)
      const release = join(value.root, 'releases', value.commit)
      mkdirSync(join(value.root, 'releases'), { mode: 0o700 })
      execFileSync('/usr/bin/git', [
        `--git-dir=${join(value.root, 'repository.git')}`,
        'worktree', 'add', '--detach', release, value.commit,
      ], { stdio: 'ignore' })
      execFileSync('/usr/bin/git', [
        `--git-dir=${join(value.root, 'repository.git')}`,
        'worktree', 'lock', '--reason', 'initializing', release,
      ], { stdio: 'ignore' })
      if (phase === 'pre-head') {
        const adminRoot = join(value.root, 'repository.git', 'worktrees')
        const names = readdirSync(adminRoot)
        expect(names).toHaveLength(1)
        writeFileSync(join(adminRoot, names[0] as string, 'HEAD'), `${'0'.repeat(40)}\n`)
      } else if (phase === 'missing') {
        rmSync(release, { recursive: true })
      }

      const ports = nodeManagedUpdatePorts()
      expect(() => phase === 'missing'
        ? ports.pruneWorktrees(value.root)
        : ports.removeRelease(value.root, value.commit)).not.toThrow()
      expect(existsSync(release)).toBe(false)
      expect(() => execFileSync('/usr/bin/git', [
        `--git-dir=${join(value.root, 'repository.git')}`,
        'worktree', 'add', '--detach', release, value.commit,
      ], { stdio: 'ignore' })).not.toThrow()
    },
  )

  it('detects mutation of ignored runtime output and dependency files', () => {
    const value = fixture()
    const release = join(value.root, 'releases', A)
    for (const relative of [
      'node_modules/dependency',
      'packages/app/dist/bin',
      'packages/app/node_modules',
      'packages/core-ts/dist',
      'packages/core-ts/node_modules',
      'packages/telegram-gw/dist',
      'packages/telegram-gw/node_modules',
    ]) mkdirSync(join(release, relative), { recursive: true, mode: 0o700 })
    writeFileSync(join(release, 'node_modules/dependency/index.js'), 'export const ok = true\n')
    writeFileSync(join(release, 'packages/app/dist/bin/aisy.js'), 'process.exit(0)\n')
    writeFileSync(join(release, 'packages/core-ts/dist/index.js'), 'export {}\n')
    writeFileSync(join(release, 'packages/telegram-gw/dist/index.js'), 'export {}\n')

    recordManagedReleaseIntegrity(value.root, A)
    expect(() => verifyManagedReleaseIntegrity(value.root, A)).not.toThrow()
    writeFileSync(join(release, 'node_modules/dependency/index.js'), 'tampered\n')
    expect(() => verifyManagedReleaseIntegrity(value.root, A)).toThrowError(
      expect.objectContaining({ code: 'UPDATE_SOURCE_REFUSED' }),
    )

    writeFileSync(join(release, 'node_modules/dependency/index.js'), 'export const ok = true\n')
    recordManagedReleaseIntegrity(value.root, A)
    writeFileSync(join(release, 'packages/app/node_modules/injected.js'), 'tampered\n')
    expect(() => verifyManagedReleaseIntegrity(value.root, A)).toThrowError(
      expect.objectContaining({ code: 'UPDATE_SOURCE_REFUSED' }),
    )
  })

  it('reports invalid update arguments before managed-layout discovery', async () => {
    const errors: string[] = []

    await expect(runManagedUpdateCli(['--unknown'], {
      out: () => undefined,
      err: value => errors.push(value),
    })).resolves.toBe(2)
    expect(errors).toEqual([
      'usage: aisy update [--rollback | --cleanup | --resume-auto-skills | --allow-rewrite=<full-sha>]',
    ])

    errors.length = 0
    await expect(runManagedUpdateCli(['--allow-rewrite=short'], {
      out: () => undefined,
      err: value => errors.push(value),
    })).resolves.toBe(2)
    expect(errors).toHaveLength(1)
  })

  it('publishes an initial generation without previous and an exact launcher', () => {
    const value = fixture()

    const generation = bootstrapManagedInstall(
      { root: value.root, binDir: value.binDir, commit: A },
      value.ports,
    )

    expect(generation).toMatchObject({ current: A, previous: null })
    expect(activeLinks(value)).toEqual({ current: A, previous: null })
    expect(readFileSync(join(value.binDir, 'aisy'), 'utf8')).toContain('/active/current/')
    expect(lstatSync(join(value.binDir, 'aisy')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(value.root, 'update-state.json'))).toBe(false)
  })

  it('is idempotent for the exact managed root and launcher', () => {
    const value = fixture()
    bootstrap(value)
    value.verified.length = 0

    const generation = bootstrapManagedInstall(
      { root: value.root, binDir: value.binDir, commit: A },
      value.ports,
    )

    expect(generation.current).toBe(A)
    expect(value.verified).toEqual([])
  })

  it('refuses regular, dangling-symlink and foreign managed launchers before cutover', () => {
    for (const kind of ['regular', 'symlink', 'foreign'] as const) {
      const value = fixture()
      const launcher = join(value.binDir, 'aisy')
      if (kind === 'regular') writeFileSync(launcher, 'foreign\n', { mode: 0o755 })
      if (kind === 'symlink') symlinkSync(join(value.root, 'missing'), launcher)
      if (kind === 'foreign') {
        const other = fixture()
        bootstrap(other)
        writeFileSync(launcher, readFileSync(join(other.binDir, 'aisy')), { mode: 0o755 })
      }

      expect(() => bootstrap(value)).toThrowError(
        expect.objectContaining({ code: 'UPDATE_LAUNCHER_REFUSED' }),
      )
      expect(existsSync(join(value.root, 'active'))).toBe(false)
    }
  })

  it('builds and verifies B before one active-generation switch', () => {
    const value = fixture()
    bootstrap(value)

    const generation = updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)

    expect(generation).toMatchObject({ current: B, previous: A })
    expect(activeLinks(value)).toEqual({ current: B, previous: A })
    expect(value.prepared).toEqual([B])
    expect(value.verified.at(-1)).toBe(B)
  })

  it('requires exact fetched full SHA authority for a rewritten master', () => {
    const value = fixture()
    bootstrap(value)
    value.ancestor = false

    expect(() => updateManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_HISTORY_REFUSED' }))
    expect(activeLinks(value)).toEqual({ current: A, previous: null })

    expect(updateManagedInstall(
      { root: value.root, binDir: value.binDir, allowRewrite: B }, value.ports,
    )).toMatchObject({ current: B, previous: A })
  })

  it('never rebuilds an authorized rewrite target retained as previous', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.target = A
    value.ancestor = false
    value.prepared.length = 0
    value.ports.prepareRelease = () => { throw new Error('must not build previous') }

    const generation = updateManagedInstall(
      { root: value.root, binDir: value.binDir, allowRewrite: A }, value.ports,
    )

    expect(generation).toMatchObject({ current: A, previous: B })
    expect(value.prepared).toEqual([])
    expect(activeLinks(value)).toEqual({ current: A, previous: B })
  })

  it('refuses an unnecessary or mismatched rewrite authority', () => {
    const value = fixture()
    bootstrap(value)

    expect(() => updateManagedInstall(
      { root: value.root, binDir: value.binDir, allowRewrite: C }, value.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_HISTORY_REFUSED' }))
    expect(activeLinks(value).current).toBe(A)
  })

  it('keeps active A when build or staged doctor fails', () => {
    const build = fixture()
    bootstrap(build)
    build.ports.prepareRelease = () => { throw new Error('build') }
    expect(() => updateManagedInstall(
      { root: build.root, binDir: build.binDir }, build.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_BUILD_FAILED' }))
    expect(activeLinks(build).current).toBe(A)

    const doctor = fixture()
    bootstrap(doctor)
    doctor.failVerify.add(B)
    expect(() => updateManagedInstall(
      { root: doctor.root, binDir: doctor.binDir }, doctor.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_DOCTOR_FAILED' }))
    expect(activeLinks(doctor).current).toBe(A)
  })

  it('preserves typed source failures instead of reporting them as build failures', () => {
    const value = fixture()
    bootstrap(value)
    value.ports.prepareRelease = () => {
      throw new ManagedUpdateFailure('UPDATE_SOURCE_REFUSED')
    }

    expect(() => updateManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_SOURCE_REFUSED' }))
  })

  it.each([
    'journal:after-prepared',
    'journal:after-verified',
    'generation:after-mkdir',
    'generation:after-fsync',
    'generation:after-rename',
    'generation:after-dir-fsync',
    'active:before-rename',
    'active:after-rename',
    'active:after-dir-fsync',
  ])('recovers a fault at %s to one consistent pair', point => {
    const value = fixture()
    bootstrap(value)
    value.faultAt.add(point)

    expect(() => updateManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )).toThrow()
    expect([A, B]).toContain(activeLinks(value).current)

    const recovered = updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    expect(recovered).toMatchObject({ current: B, previous: A })
    expect(activeLinks(value)).toEqual({ current: B, previous: A })
  })

  it.each([
    'journal:after-verified',
    'generation:after-mkdir',
    'generation:after-fsync',
    'generation:after-rename',
    'generation:after-dir-fsync',
    'active:before-rename',
    'active:after-rename',
    'active:after-dir-fsync',
  ])('recovers initial bootstrap fault at %s without inventing previous', point => {
    const value = fixture()
    value.faultAt.add(point)

    expect(() => bootstrap(value)).toThrow()
    bootstrap(value)

    expect(activeLinks(value)).toEqual({ current: A, previous: null })
  })

  it('rolls back offline by publishing the reverse pair', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.fetched = 0

    const generation = rollbackManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )

    expect(generation).toMatchObject({ current: A, previous: B })
    expect(activeLinks(value)).toEqual({ current: A, previous: B })
    expect(value.fetched).toBe(0)
    expect(value.rollbackPrepared).toEqual([A])
    expect(value.rollbackVerified).toEqual([A])
  })

  it('rolls forward to a descendant previous without issuing a second downgrade certificate', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.autoSkillRollback = 'safe'
    rollbackManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.rollbackPrepared = []
    value.rollbackVerified = []
    value.prepared = []
    value.verified = []

    const generation = updateManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )

    expect(generation).toMatchObject({ current: B, previous: A })
    expect(activeLinks(value)).toEqual({ current: B, previous: A })
    expect(value.prepared).toEqual([])
    expect(value.verified).toEqual([B])
    expect(value.rollbackPrepared).toEqual([])
    expect(value.rollbackVerified).toEqual([])
  })

  it('refuses descendant previous when retained ignored runtime output was changed', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    const retained = join(value.root, 'releases', B)
    for (const relative of [
      'node_modules/dependency',
      'packages/app/dist',
      'packages/app/node_modules',
      'packages/core-ts/dist',
      'packages/core-ts/node_modules',
      'packages/telegram-gw/dist',
      'packages/telegram-gw/node_modules',
    ]) mkdirSync(join(retained, relative), { recursive: true, mode: 0o700 })
    writeFileSync(join(retained, 'node_modules/dependency/index.js'), 'export const ok = true\n')
    writeFileSync(join(retained, 'packages/app/dist/aisy.js'), 'export const clean = true\n')
    writeFileSync(join(retained, 'packages/core-ts/dist/index.js'), 'export {}\n')
    writeFileSync(join(retained, 'packages/telegram-gw/dist/index.js'), 'export {}\n')
    recordManagedReleaseIntegrity(value.root, B)
    value.autoSkillRollback = 'safe'
    rollbackManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    writeFileSync(join(retained, 'packages/app/dist/injected.js'), 'ignored tamper\n')
    const prepare = value.ports.prepareRelease
    value.ports.prepareRelease = (root, commit) => {
      prepare(root, commit)
      recordManagedReleaseIntegrity(root, commit)
    }
    value.ports.verifyRelease = (root, commit) => verifyManagedReleaseIntegrity(root, commit)

    expect(() => updateManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_SOURCE_REFUSED' }))
    expect(activeLinks(value)).toEqual({ current: A, previous: B })
  })

  it('refuses rollback when v2 state drifts before the active switch', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.autoSkillRollback = 'safe'
    const originalVerify = value.ports.verifyAutoSkillRollback
    value.ports.verifyAutoSkillRollback = (targetCommit, authorization) => {
      value.autoSkillRollback = 'drifted'
      originalVerify(targetCommit, authorization)
    }

    expect(() => rollbackManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_STATE_REFUSED' }))
    expect(activeLinks(value)).toEqual({ current: B, previous: A })
  })

  it('applies the same v2 gate to allow-rewrite back to previous', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.target = A
    value.ancestor = false
    value.autoSkillRollback = 'drifted'

    expect(() => updateManagedInstall(
      { root: value.root, binDir: value.binDir, allowRewrite: A }, value.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_STATE_REFUSED' }))
    expect(activeLinks(value)).toEqual({ current: B, previous: A })
  })

  it('applies the v2 gate to every non-descendant allow-rewrite target', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.target = C
    value.ancestor = false
    value.autoSkillRollback = 'drifted'

    expect(() => updateManagedInstall(
      { root: value.root, binDir: value.binDir, allowRewrite: C }, value.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_STATE_REFUSED' }))
    expect(activeLinks(value)).toEqual({ current: B, previous: A })
    expect(value.rollbackPrepared).toEqual([C])
  })

  it('refuses rollback without previous or when previous doctor fails', () => {
    const initial = fixture()
    bootstrap(initial)
    expect(() => rollbackManagedInstall(
      { root: initial.root, binDir: initial.binDir }, initial.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_STATE_REFUSED' }))

    const failed = fixture()
    bootstrap(failed)
    updateManagedInstall({ root: failed.root, binDir: failed.binDir }, failed.ports)
    failed.failVerify.add(A)
    expect(() => rollbackManagedInstall(
      { root: failed.root, binDir: failed.binDir }, failed.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_DOCTOR_FAILED' }))
    expect(activeLinks(failed)).toEqual({ current: B, previous: A })
  })

  it('requires the kernel-lock port and ignores forged ambient lock markers', () => {
    const locked = fixture()
    bootstrap(locked)
    locked.ports.withOperationLock = () => {
      throw new ManagedUpdateFailure('UPDATE_BUSY')
    }
    const previousManaged = process.env['AISY_MANAGED_UPDATE_LOCK_HELD']
    const previousBootstrap = process.env['AISY_BOOTSTRAP_LOCK_HELD']
    process.env['AISY_MANAGED_UPDATE_LOCK_HELD'] = '1'
    process.env['AISY_BOOTSTRAP_LOCK_HELD'] = '1'
    try {
      expect(() => updateManagedInstall(
        { root: locked.root, binDir: locked.binDir }, locked.ports,
      )).toThrowError(expect.objectContaining({ code: 'UPDATE_BUSY' }))
    } finally {
      if (previousManaged === undefined) delete process.env['AISY_MANAGED_UPDATE_LOCK_HELD']
      else process.env['AISY_MANAGED_UPDATE_LOCK_HELD'] = previousManaged
      if (previousBootstrap === undefined) delete process.env['AISY_BOOTSTRAP_LOCK_HELD']
      else process.env['AISY_BOOTSTRAP_LOCK_HELD'] = previousBootstrap
    }
  })

  it('rejects malformed journal under the operation lock', () => {
    const malformed = fixture()
    bootstrap(malformed)
    writeFileSync(join(malformed.root, 'update-state.json'), '{"schemaVersion":2}\n')
    expect(() => updateManagedInstall(
      { root: malformed.root, binDir: malformed.binDir }, malformed.ports,
    )).toThrowError(expect.objectContaining({ code: 'UPDATE_STATE_REFUSED' }))
  })

  it('cleans only unreferenced managed generations and releases', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.target = C
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)

    const active = cleanupManagedInstall(
      { root: value.root, binDir: value.binDir },
      value.ports,
    )

    expect(active).toMatchObject({ current: C, previous: B })
    expect(value.removed).toEqual([A])
    expect(existsSync(join(value.root, 'releases', B))).toBe(true)
    expect(existsSync(join(value.root, 'releases', C))).toBe(true)
    expect(readdirSync(join(value.root, 'generations'))).toEqual([active.id])
  })

  it('keeps normal update retention bounded without an explicit cleanup command', () => {
    const value = fixture()
    bootstrap(value)
    for (const target of [B, C, D]) {
      value.target = target
      updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    }

    expect(activeLinks(value)).toEqual({ current: D, previous: C })
    expect(readdirSync(join(value.root, 'releases')).sort()).toEqual([B, C, D])
    expect(readdirSync(join(value.root, 'generations'))).toHaveLength(2)
    expect(value.removed).toEqual([A])
  })

  it.each([
    'cleanup:generation-after-rename',
    'cleanup:generation-after-unlink',
  ])('recovers interrupted generation cleanup at %s', point => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.faultAt.add(point)

    expect(() => cleanupManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )).toThrow()
    const recovered = cleanupManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )

    expect(readdirSync(join(value.root, 'generations'))).toEqual([recovered.id])
    expect(activeLinks(value)).toEqual({ current: B, previous: A })
  })

  it('sweeps an orphan integrity record after interrupted worktree removal', () => {
    const value = fixture()
    bootstrap(value)
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    value.target = C
    updateManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    const integrityRoot = join(value.root, 'integrity')
    mkdirSync(integrityRoot, { mode: 0o700 })
    const orphan = join(integrityRoot, `${A}.json`)
    writeFileSync(orphan, '{}\n', { mode: 0o600 })
    value.faultAt.add('cleanup:release-after-remove')

    expect(() => cleanupManagedInstall(
      { root: value.root, binDir: value.binDir }, value.ports,
    )).toThrow()
    expect(existsSync(join(value.root, 'releases', A))).toBe(false)
    expect(existsSync(orphan)).toBe(true)

    cleanupManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)
    expect(existsSync(orphan)).toBe(false)
  })

  it('recovers an exact interrupted integrity temporary under the operation lock', () => {
    const value = fixture()
    bootstrap(value)
    const integrityRoot = join(value.root, 'integrity')
    mkdirSync(integrityRoot, { mode: 0o700 })
    const temporary = join(integrityRoot, `.${A}.json.tmp-999999`)
    writeFileSync(temporary, '{"partial":true}\n', { mode: 0o600 })

    cleanupManagedInstall({ root: value.root, binDir: value.binDir }, value.ports)

    expect(existsSync(temporary)).toBe(false)
  })

  it('refuses root authority before touching managed state', () => {
    const value = fixture()
    const ports = { ...value.ports, effectiveUid: () => 0 }

    expect(() => bootstrapManagedInstall(
      { root: value.root, binDir: value.binDir, commit: A }, ports,
    )).toThrowError(ManagedUpdateFailure)
    expect(existsSync(join(value.root, 'active'))).toBe(false)
  })
})

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const installer = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url))
const roots: string[] = []
const commit = 'a'.repeat(40)

function executable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

interface ProcessFixture {
  root: string
  binDir: string
  env: NodeJS.ProcessEnv
  log: string
  installer: string
  failCorepack: string
  failAfterAdd: string
  failAfterAddMissing: string
}

function processFixture(): ProcessFixture {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-install-script-')))
  roots.push(sandbox)
  const shims = join(sandbox, 'shims')
  const userDir = join(sandbox, 'user')
  const root = join(userDir, 'managed')
  const binDir = join(userDir, 'bin')
  const log = join(sandbox, 'calls.log')
  const failCorepack = join(sandbox, 'fail-corepack')
  const failAfterAdd = join(sandbox, 'fail-after-add')
  const failAfterAddMissing = join(sandbox, 'fail-after-add-missing')
  const runtime = `#!${process.execPath}\n`
  mkdirSync(shims, { mode: 0o700 })
  mkdirSync(userDir, { mode: 0o700 })

  executable(join(shims, 'node'), runtime + String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === '-p') { process.stdout.write('22'); process.exit(0) }
if (args[0] === '-e') {
  process.argv = [process.execPath, ...args.slice(2)]
  eval(args[1])
  process.exit(0)
}
const values = Object.fromEntries(args.slice(1).map(value => value.split('=', 2)))
const installRoot = values['--install-root']
const binDir = values['--bin-dir']
const commit = values['--commit']
const generation = path.join(installRoot, 'generations', 'g-aaaaaaaaaaaaaaaa')
fs.mkdirSync(generation, { recursive: true, mode: 0o700 })
fs.mkdirSync(binDir, { recursive: true, mode: 0o700 })
const current = path.join(generation, 'current')
if (!fs.existsSync(current)) fs.symlinkSync('../../releases/' + commit, current)
const active = path.join(installRoot, 'active')
if (!fs.existsSync(active)) fs.symlinkSync('generations/g-aaaaaaaaaaaaaaaa', active)
const launcher = path.join(binDir, 'aisy')
fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
`)
  const gitShim = join(shims, 'git')
  executable(gitShim, runtime + `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const forbidden = [
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR',
  'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_SSL_NO_VERIFY', 'GIT_PROXY_COMMAND',
]
if (forbidden.some(key => process.env[key] !== undefined)) process.exit(91)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (args[0] === 'clone') {
  const repository = args.at(-1)
  fs.mkdirSync(repository, { recursive: true })
  fs.writeFileSync(path.join(repository, 'origin'), 'https://github.com/veeskelad/aisy-agent.git')
} else if (args[0].startsWith('--git-dir=')) {
  const repository = args[0].slice('--git-dir='.length)
  const registry = path.join(repository, 'worktree-registry.json')
  if (args[1] === 'config') process.stdout.write(fs.readFileSync(path.join(repository, 'origin')))
  if (args[1] === 'rev-parse') process.stdout.write('${commit}\\n')
  if (args[1] === 'worktree') {
    const operation = args[2]
    if (operation === 'prune' && fs.existsSync(registry)) {
      const value = JSON.parse(fs.readFileSync(registry, 'utf8'))
      if (!fs.existsSync(value.release)) fs.rmSync(registry, { force: true })
    }
    if (operation === 'list' && fs.existsSync(registry)) {
      const value = JSON.parse(fs.readFileSync(registry, 'utf8'))
      process.stdout.write(
        'worktree ' + value.release + '\\0HEAD ' + value.commit + '\\0detached\\0' +
        (value.locked ? 'locked ' + value.locked + '\\0' : '') + '\\0',
      )
    }
    if (operation === 'remove') {
      const value = JSON.parse(fs.readFileSync(registry, 'utf8'))
      if (value.locked && args.filter(value => value === '--force').length !== 2) process.exit(88)
      fs.rmSync(args.at(-1), { recursive: true, force: true })
      fs.rmSync(registry, { force: true })
    }
    if (operation === 'add') {
      const release = args[4]
      fs.mkdirSync(path.join(release, 'packages/app/dist/bin'), { recursive: true })
      fs.writeFileSync(path.join(release, '.head'), '${commit}\\n')
      fs.writeFileSync(path.join(release, 'packages/app/dist/bin/managed-bootstrap.js'), 'bootstrap\\n')
      fs.writeFileSync(registry, JSON.stringify({ release, commit: args[5] }))
      if (fs.existsSync(${JSON.stringify(failAfterAddMissing)})) {
        fs.rmSync(${JSON.stringify(failAfterAddMissing)})
        fs.writeFileSync(registry, JSON.stringify({ release, commit: args[5], locked: 'initializing' }))
        fs.rmSync(release, { recursive: true, force: true })
        process.exit(86)
      }
      if (fs.existsSync(${JSON.stringify(failAfterAdd)})) {
        fs.rmSync(${JSON.stringify(failAfterAdd)})
        fs.writeFileSync(registry, JSON.stringify({ release, commit: args[5], locked: 'initializing' }))
        fs.rmSync(path.join(release, 'packages/app/dist/bin/managed-bootstrap.js'))
        process.exit(86)
      }
    }
  }
} else if (args[0] === '-C') {
  if (args[2] === 'rev-parse') process.stdout.write(fs.readFileSync(path.join(args[1], '.head')))
}
`)
  executable(join(shims, 'corepack'), runtime + `
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, 'corepack ' + process.argv.slice(2).join(' ') + '\\n')
if (fs.existsSync(${JSON.stringify(failCorepack)})) process.exit(87)
`)
  const flockShim = join(shims, 'flock')
  executable(flockShim, runtime + String.raw`
const args = process.argv.slice(2)
if (args.join(' ') !== '-E 75 -n 9') process.exit(2)
if (process.env.AISY_TEST_FLOCK_BUSY === '1') process.exit(75)
`)

  const fixtureInstaller = join(sandbox, 'install.sh')
  executable(
    fixtureInstaller,
    readFileSync(installer, 'utf8')
      .replace("GIT_BIN='/usr/bin/git'", `GIT_BIN='${gitShim}'`)
      .replace("FLOCK_BIN='/usr/bin/flock'", `FLOCK_BIN='${flockShim}'`),
  )
  return {
    root,
    binDir,
    log,
    installer: fixtureInstaller,
    failCorepack,
    failAfterAdd,
    failAfterAddMissing,
    env: {
      ...process.env,
      HOME: userDir,
      AISY_INSTALL_ROOT: root,
      AISY_BIN_DIR: binDir,
      PATH: `${shims}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('managed Git bootstrap script', () => {
  it('uses only the canonical Git channel and frozen dependency graph', () => {
    const source = readFileSync(installer, 'utf8')

    expect(source).toContain("ORIGIN='https://github.com/veeskelad/aisy-agent.git'")
    expect(source).toContain("BRANCH='master'")
    expect(source).toContain('install --frozen-lockfile')
    expect(source).toContain('--config.package-import-method=copy')
    expect(source).toContain('managed-bootstrap.js')
    expect(source).not.toMatch(/\b(?:apt|apt-get|dpkg)\b/)
    expect(source).not.toMatch(/\bsudo\b/)
  })

  it('refuses root and path collisions instead of installing system prerequisites', () => {
    const source = readFileSync(installer, 'utf8')

    expect(source).toContain('"${EUID:-$(id -u)}" -eq 0')
    expect(source).toContain('UPDATE_NOT_MANAGED')
    expect(source).toContain('CURRENT_ORIGIN')
    expect(source).toContain('CANONICAL_INSTALL_ROOT')
    expect(source).toContain('ls-tree", "-rz", "--full-tree')
    expect(source).toContain('cat-file", "--batch')
    expect(source).not.toContain('cat-file", "-s"')
    expect(source).toContain('ACTIVE_TARGET')
    expect(source).toContain('CURRENT_TARGET')
    expect(source).toContain('GIT_CONFIG_NOSYSTEM=1')
    expect(source).toContain('GIT_CONFIG_GLOBAL=/dev/null')
    expect(source).toContain("GIT_BIN='/usr/bin/git'")
    expect(source).toContain("FLOCK_BIN='/usr/bin/flock'")
    expect(source).toContain('"$FLOCK_BIN" -E 75 -n 9')
    expect(source).not.toContain('AISY_BOOTSTRAP_LOCK_HELD')
    expect(source).toContain('clone --bare --single-branch --branch "$BRANCH" --no-tags')
    expect(statSync(installer).mode & 0o100).toBe(0o100)
  })

  it('performs a hermetic initial bootstrap and repeat install through real bash', () => {
    const fixture = processFixture()

    const first = spawnSync('/bin/bash', [fixture.installer], { env: fixture.env, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    expect(readlinkSync(join(fixture.root, 'active'))).toBe('generations/g-aaaaaaaaaaaaaaaa')
    expect(lstatSync(join(fixture.binDir, 'aisy')).isSymbolicLink()).toBe(false)

    const second = spawnSync('/bin/bash', [fixture.installer], { env: fixture.env, encoding: 'utf8' })
    expect(second.status, second.stderr).toBe(0)
    const calls = readFileSync(fixture.log, 'utf8')
    expect(calls.match(/^clone /gm)).toHaveLength(1)
    expect(calls.match(/^corepack /gm)).toHaveLength(2)
    expect(existsSync(join(fixture.root, 'releases', commit))).toBe(true)
  })

  it('does not mutate a non-empty unmanaged install root', () => {
    const fixture = processFixture()
    mkdirSync(fixture.root, { mode: 0o755 })
    const sentinel = join(fixture.root, 'keep')
    writeFileSync(sentinel, 'owned by operator\n')
    const beforeMode = statSync(fixture.root).mode & 0o777

    const result = spawnSync('/bin/bash', [fixture.installer], { env: fixture.env, encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UPDATE_NOT_MANAGED')
    expect(readFileSync(sentinel, 'utf8')).toBe('owned by operator\n')
    expect(statSync(fixture.root).mode & 0o777).toBe(beforeMode)
  })

  it('reports an existing regular install root as not managed', () => {
    const fixture = processFixture()
    writeFileSync(fixture.root, 'collision\n')

    const result = spawnSync('/bin/bash', [fixture.installer], { env: fixture.env, encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('aisy install: операция отклонена (UPDATE_NOT_MANAGED)\n')
    expect(readFileSync(fixture.root, 'utf8')).toBe('collision\n')
  })

  it('refuses a concurrent initial bootstrap before Git mutation', () => {
    const fixture = processFixture()
    fixture.env.AISY_TEST_FLOCK_BUSY = '1'

    const result = spawnSync('/bin/bash', [fixture.installer], { env: fixture.env, encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UPDATE_BUSY')
    expect(existsSync(fixture.log)).toBe(false)
  })

  it('ignores persistent lockfile bytes when the kernel lock is free', () => {
    const fixture = processFixture()
    mkdirSync(fixture.root, { mode: 0o700 })
    writeFileSync(
      join(fixture.root, 'bootstrap.lock'),
      'persistent inode, authority is the kernel lock\n',
      { mode: 0o600 },
    )

    const result = spawnSync('/bin/bash', [fixture.installer], { env: fixture.env, encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(fixture.root, 'active'))).toBe(true)
  })

  it('refuses a forged internal lock flag before filesystem mutation', () => {
    const fixture = processFixture()

    const result = spawnSync('/bin/bash', [fixture.installer, '--lock-held'], {
      env: fixture.env,
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UPDATE_SOURCE_REFUSED')
    expect(existsSync(fixture.root)).toBe(false)
  })

  it('does not misreport a dependency failure as lock contention', () => {
    const fixture = processFixture()
    writeFileSync(fixture.failCorepack, 'fail\n')

    const result = spawnSync('/bin/bash', [fixture.installer], {
      env: fixture.env,
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UPDATE_BUILD_FAILED')
    expect(result.stderr).not.toContain('UPDATE_BUSY')
  })

  it('strips ambient Git configuration and transport overrides', () => {
    const fixture = processFixture()
    fixture.env.GIT_CONFIG_COUNT = '1'
    fixture.env.GIT_CONFIG_KEY_0 = 'url.file:///attacker/repo.insteadOf'
    fixture.env.GIT_CONFIG_VALUE_0 = 'https://github.com/veeskelad/aisy-agent.git'
    fixture.env.GIT_SSL_NO_VERIFY = '1'

    const result = spawnSync('/bin/bash', [fixture.installer], {
      env: fixture.env,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(fixture.root, 'active'))).toBe(true)
  })

  it.each(['partial', 'missing'] as const)(
    'recovers an interrupted %s initial worktree registration',
    residue => {
      const fixture = processFixture()
      writeFileSync(
        residue === 'partial' ? fixture.failAfterAdd : fixture.failAfterAddMissing,
        'fail\n',
      )

      const first = spawnSync('/bin/bash', [fixture.installer], {
        env: fixture.env,
        encoding: 'utf8',
      })
      expect(first.status).toBe(1)
      expect(first.stderr).toContain('UPDATE_SOURCE_REFUSED')

      const recovered = spawnSync('/bin/bash', [fixture.installer], {
        env: fixture.env,
        encoding: 'utf8',
      })
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(existsSync(join(fixture.root, 'active'))).toBe(true)
    },
  )
})

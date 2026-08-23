import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  makeSwitchAuthority,
  type ProjectRegistryStateV2,
} from '@aisy/core'
import {
  makeProjectProvisioner,
  makeNodeProjectProvisioner,
  renderProjectsCatalog,
  type ProjectProvisioningFs,
} from './project-provisioner.js'
import type { ConfinementTreeScanner } from './confinement-tree-scanner.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const PROJECTS_ROOT = POLICY.projectsRoot
const CONTROL_ROOT = '/Users/operator/.aisy'
const RESERVATIONS_ROOT = `${CONTROL_ROOT}/project-reservations`
const WORKSPACE_ROOT = '/Users/operator/workspace'

function scanner(scanned: string[] = []): ConfinementTreeScanner {
  return {
    scanRoot: async (root) => {
      scanned.push(root)
      return { entries: 8, files: 3, directories: 5, totalBytes: 256 }
    },
  }
}

function runtime(options: { failRegistry?: boolean } = {}) {
  let id = 0
  let durable: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: WORKSPACE_ROOT,
    nowIso: () => '2026-07-26T21:00:00.000Z',
    newId: () => `id-${++id}`,
    policy: POLICY,
  })
  const registry = makeProjectRegistryV2({
    state: durable,
    policy: POLICY,
    nowIso: () => '2026-07-26T21:00:00.000Z',
    newId: () => `id-${++id}`,
    persistence: {
      saveAtomic: (state) => {
        if (options.failRegistry && state.projects.length > 1) throw new Error('registry fsync failed')
        durable = state
      },
    },
  })
  let leaseId = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
  const nonces = new Map<string, { mac: string }>()
  const authority = makeSwitchAuthority({
    secret: Buffer.alloc(32, 6),
    nowMs: () => Date.parse('2026-07-26T21:00:00.000Z'),
    newId: () => 'receipt-unused',
    nonces: {
      issue: (record) => { nonces.set(record.receiptId, record) },
      has: (receiptId, mac) => nonces.get(receiptId)?.mac === mac,
      consume: (receiptId, mac) => {
        if (nonces.get(receiptId)?.mac !== mac) return false
        nonces.delete(receiptId)
        return true
      },
    },
  })
  return {
    registry,
    service: makeProjectService({ registry, leases, authority }),
  }
}

function memoryFs(options: {
  failLayoutWrite?: boolean
  failFinalRename?: boolean
  failCatalog?: boolean
  failQuarantineRename?: boolean
} = {}) {
  const directories = new Set([PROJECTS_ROOT, RESERVATIONS_ROOT, WORKSPACE_ROOT])
  const files = new Map<string, string>()
  const calls: string[] = []

  const moveTree = (from: string, to: string) => {
    if (!directories.has(from)) throw new Error('source missing')
    if (options.failFinalRename && to === `${PROJECTS_ROOT}/project-b`) {
      throw new Error('rename failed')
    }
    if (options.failQuarantineRename && to.includes('/.aisy-quarantine-')) {
      throw new Error('quarantine rename failed')
    }
    if (directories.has(to) || files.has(to)) throw new Error('target exists')
    const movedDirectories = [...directories].filter(
      (path) => path === from || path.startsWith(from + '/'),
    )
    const movedFiles = [...files].filter(([path]) => path.startsWith(from + '/'))
    for (const path of movedDirectories) directories.delete(path)
    for (const [path] of movedFiles) files.delete(path)
    for (const path of movedDirectories) directories.add(to + path.slice(from.length))
    for (const [path, content] of movedFiles) files.set(to + path.slice(from.length), content)
  }

  const fs: ProjectProvisioningFs = {
    exists: (path) => directories.has(path) || files.has(path),
    createDirectoryExclusive: (path) => {
      calls.push(`mkdir-exclusive:${path}`)
      if (directories.has(path) || files.has(path)) return false
      if (!directories.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('parent missing')
      directories.add(path)
      return true
    },
    createDirectory: (path) => {
      calls.push(`mkdir:${path}`)
      if (directories.has(path) || files.has(path)) throw new Error('exists')
      if (!directories.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('parent missing')
      directories.add(path)
    },
    writeFileExclusive: (path, content) => {
      calls.push(`write:${path}`)
      if (options.failLayoutWrite && path.endsWith('/.current-task.md')) throw new Error('disk full')
      if (directories.has(path) || files.has(path)) throw new Error('exists')
      if (!directories.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('parent missing')
      files.set(path, content)
    },
    syncFile: (path) => { calls.push(`fsync:${path}`) },
    syncDirectory: (path) => { calls.push(`fsync-dir:${path}`) },
    renameDirectory: (from, to) => {
      calls.push(`rename:${from}->${to}`)
      moveTree(from, to)
    },
    removeFile: (path) => {
      calls.push(`unlink:${path}`)
      if (!files.delete(path)) throw new Error('file missing')
    },
    removeEmptyDirectory: (path) => {
      calls.push(`rmdir:${path}`)
      if (!directories.has(path) || [...directories].some((item) => item.startsWith(path + '/')) ||
        [...files].some(([item]) => item.startsWith(path + '/'))) {
        throw new Error('not empty or missing')
      }
      directories.delete(path)
    },
    publishFileAtomic: (path, content) => {
      calls.push(`publish:${path}`)
      if (options.failCatalog) throw new Error('catalog fsync failed')
      files.set(path, content)
    },
    inspectDirectory: (path) => {
      if (!directories.has(path)) throw new Error('not found')
      return { canonicalRoot: path, identity: `directory:${path}` }
    },
  }
  return { calls, directories, files, fs }
}

describe('project provisioner', () => {
  it('creates the canonical layout, publishes one registry row/session, lease, and PROJECTS.md', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(memory.calls),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'create-1',
    })

    const result = await provisioner.createProject({ ...OWNER, name: 'Project B' })

    expect(result).toMatchObject({
      root: `${PROJECTS_ROOT}/project-b`,
      slug: 'project-b',
      catalogAudit: 'published',
      reservationAudit: 'released',
    })
    expect(result.lease).toMatchObject({
      projectId: result.selection.projectId,
      sessionId: result.selection.sessionId,
      root: result.root,
      projectKind: 'project',
    })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(1)
    expect(memory.directories.has(`${result.root}/memory/facts`)).toBe(true)
    expect(memory.directories.has(`${result.root}/knowledge`)).toBe(true)
    expect(memory.directories.has(`${result.root}/tasks`)).toBe(true)
    expect(memory.directories.has(`${result.root}/skills`)).toBe(true)
    expect(memory.files.get(`${result.root}/.aisy-project.json`)).toContain('"origin": "created"')
    expect(memory.files.get(`${WORKSPACE_ROOT}/PROJECTS.md`)).toContain('Project B | Project | активен')
    const scanIndex = memory.calls.findIndex((item) => item.startsWith(`${PROJECTS_ROOT}/.aisy-staging-`))
    const renameIndex = memory.calls.findIndex((item) => item.startsWith('rename:'))
    expect(scanIndex).toBeGreaterThan(-1)
    expect(renameIndex).toBeGreaterThan(scanIndex)
    expect([...memory.directories].some((path) => path.includes('.aisy-staging-'))).toBe(false)
    expect([...memory.directories].some((path) => path.startsWith(RESERVATIONS_ROOT + '/'))).toBe(false)
  })

  it('clones only through a reviewed target, scans it, then atomically publishes origin=cloned', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const resolveDns = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ])
    const clone = vi.fn(async (input: { stagingRoot: string; target: { hostname: string } }) => {
      memory.calls.push(`clone:${input.target.hostname}:${input.stagingRoot}`)
      memory.fs.writeFileExclusive(`${input.stagingRoot}/README.md`, '# cloned\n')
    })
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(memory.calls),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'clone-1',
      clone: { dns: { resolve: resolveDns }, transport: { clone } },
    })

    const result = await provisioner.cloneProject({
      ...OWNER,
      name: 'Cloned Project',
      url: 'https://EXAMPLE.org:443/team/repo.git',
    })

    expect(result).toMatchObject({
      root: `${PROJECTS_ROOT}/cloned-project`,
      slug: 'cloned-project',
      catalogAudit: 'published',
      reservationAudit: 'released',
    })
    expect(resolveDns).toHaveBeenCalledWith('example.org', undefined)
    expect(clone).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        url: 'https://example.org/team/repo.git',
        hostname: 'example.org',
        addresses: [{ address: '93.184.216.34', family: 4 }],
      }),
      stagingRoot: expect.stringContaining('/.aisy-staging-'),
    }))
    const context = registry.listContexts(OWNER).find((item) => item.slug === 'cloned-project')
    expect(context).toMatchObject({ origin: 'cloned', root: result.root })
    expect(memory.files.get(`${result.root}/README.md`)).toBe('# cloned\n')
    const cloneIndex = memory.calls.findIndex((item) => item.startsWith('clone:'))
    const scanIndex = memory.calls.findIndex((item) => item.startsWith(`${PROJECTS_ROOT}/.aisy-staging-`))
    const renameIndex = memory.calls.findIndex((item) => item.startsWith('rename:'))
    expect(scanIndex).toBeGreaterThan(cloneIndex)
    expect(renameIndex).toBeGreaterThan(scanIndex)
  })

  it('keeps clone disabled unless both DNS policy and transport are composed', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'disabled-clone',
    })

    await expect(provisioner.cloneProject({
      ...OWNER,
      name: 'Cloned Project',
      url: 'https://example.org/team/repo.git',
    })).rejects.toMatchObject({ code: 'PROJECT_CLONE_DISABLED' })
    expect(memory.calls).toEqual([])
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
  })

  it('registers a stable existing directory through ProjectService without modifying it', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const existingRoot = '/Users/operator/existing-project'
    memory.directories.add(existingRoot)
    const scanned: string[] = []
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(scanned),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'register-unused',
    })

    const result = await provisioner.registerProject({
      ...OWNER,
      name: 'Existing Project',
      root: existingRoot,
    })

    expect(result).toMatchObject({
      root: existingRoot,
      slug: 'existing-project',
      catalogAudit: 'published',
      rootAudit: 'stable',
    })
    expect(scanned).toEqual([existingRoot])
    expect(registry.listContexts(OWNER).find((item) => item.root === existingRoot))
      .toMatchObject({ origin: 'registered', slug: 'existing-project' })
    expect(memory.directories.has(existingRoot)).toBe(true)
    expect(memory.calls.some((item) => item.startsWith('rename:') ||
      item.includes('.aisy-staging-') || item.includes('project-reservations'))).toBe(false)
  })

  it('rejects a changed existing root after scan without registry publication', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const existingRoot = '/Users/operator/raced-project'
    memory.directories.add(existingRoot)
    let inspection = 0
    const provisioner = makeProjectProvisioner({
      service,
      fs: {
        ...memory.fs,
        inspectDirectory: (path) => ({
          canonicalRoot: path,
          identity: `directory-version-${++inspection}`,
        }),
      },
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'register-race-unused',
    })

    await expect(provisioner.registerProject({
      ...OWNER,
      name: 'Raced Project',
      root: existingRoot,
    })).rejects.toMatchObject({ code: 'PROJECT_ROOT_CHANGED' })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
  })

  it('reports recovery required when register became durable before a late runtime failure', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const existingRoot = '/Users/operator/durable-project'
    memory.directories.add(existingRoot)
    const provisioner = makeProjectProvisioner({
      service: {
        ...service,
        async publishPreparedProject(input) {
          await service.publishPreparedProject(input)
          throw new Error('late observer failure')
        },
      },
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'register-durable-unused',
    })

    await expect(provisioner.registerProject({
      ...OWNER,
      name: 'Durable Project',
      root: existingRoot,
    })).rejects.toMatchObject({ code: 'PROJECT_PUBLISHED_RUNTIME_RECOVERY_REQUIRED' })
    expect(registry.listContexts(OWNER).find((item) => item.root === existingRoot))
      .toMatchObject({ origin: 'registered' })
  })

  it('rejects missing, relative and root existing paths before publication', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'register-invalid-unused',
    })

    for (const root of ['relative/project', '/', '/Users/operator/missing']) {
      await expect(provisioner.registerProject({
        ...OWNER,
        name: 'Invalid Project',
        root,
      })).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' })
    }
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
  })

  it('registers a real canonical directory and rejects a symlink with the Node adapter', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-register-project-')))
    try {
      const homeRoot = join(base, 'home')
      const workspaceRoot = join(homeRoot, 'workspace')
      const projectsRoot = join(homeRoot, 'projects')
      const controlRoot = join(homeRoot, '.aisy')
      const existingRoot = join(homeRoot, 'existing')
      const linkedRoot = join(homeRoot, 'linked')
      for (const path of [homeRoot, workspaceRoot, existingRoot]) {
        mkdirSync(path, { recursive: true, mode: 0o700 })
      }
      writeFileSync(join(existingRoot, 'README.md'), '# existing\n', { mode: 0o600 })
      symlinkSync(existingRoot, linkedRoot)
      let id = 0
      const policy = { homeRoot, projectsRoot, protectedRoots: [controlRoot] }
      const registry = makeProjectRegistryV2({
        state: makeFreshProjectRegistryV2({
          ...OWNER,
          workspaceRoot,
          nowIso: () => '2026-07-27T13:00:00.000Z',
          newId: () => `node-bootstrap-${++id}`,
          policy,
        }),
        policy,
        nowIso: () => '2026-07-27T13:00:00.000Z',
        newId: () => `node-id-${++id}`,
        persistence: { saveAtomic: () => undefined },
      })
      const service = makeProjectService({
        registry,
        authority: {
          issue: () => { throw new Error('not used') },
          validate: () => { throw new Error('not used') },
          isIssued: () => false,
          markConsumed: () => false,
          consume: () => { throw new Error('not used') },
        },
        leases: makeContextLeaseCoordinator({ newId: () => `node-lease-${++id}` }),
      })
      const scanned: string[] = []
      const provisioner = makeNodeProjectProvisioner({
        service,
        treeScanner: scanner(scanned),
        projectsRoot,
        controlRoot,
        newId: () => 'node-register-unused',
      })

      await expect(provisioner.registerProject({
        ...OWNER,
        name: 'Linked Project',
        root: linkedRoot,
      })).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' })
      const result = await provisioner.registerProject({
        ...OWNER,
        name: 'Existing Project',
        root: existingRoot,
      })

      expect(result).toMatchObject({ root: existingRoot, rootAudit: 'stable' })
      expect(scanned).toEqual([existingRoot])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it.each([
    ['http://example.org/team/repo.git', 'CLONE_URL_HTTPS_REQUIRED'],
    ['https://user@example.org/team/repo.git', 'CLONE_URL_CREDENTIALS_DENIED'],
  ])('rejects unsafe clone URL %s before reservation and transport', async (url, code) => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const clone = vi.fn(async () => undefined)
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'unsafe-clone',
      clone: {
        dns: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
        transport: { clone },
      },
    })

    await expect(provisioner.cloneProject({ ...OWNER, name: 'Clone', url })).rejects.toMatchObject({ code })
    expect(memory.calls).toEqual([])
    expect(clone).not.toHaveBeenCalled()
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
  })

  it('rejects a DNS rebinding response before reservation and transport', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const clone = vi.fn(async () => undefined)
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'rebound-clone',
      clone: {
        dns: {
          resolve: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '169.254.169.254', family: 4 },
          ],
        },
        transport: { clone },
      },
    })

    await expect(provisioner.cloneProject({
      ...OWNER,
      name: 'Clone',
      url: 'https://git.example.net/team/repo.git',
    })).rejects.toMatchObject({ code: 'CLONE_TARGET_NOT_PUBLIC' })
    expect(memory.calls).toEqual([])
    expect(clone).not.toHaveBeenCalled()
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
  })

  it('quarantines a failed clone and never publishes it', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'failed-clone',
      clone: {
        dns: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
        transport: { clone: async () => { throw new Error('git stderr secret') } },
      },
    })

    await expect(provisioner.cloneProject({
      ...OWNER,
      name: 'Clone',
      url: 'https://git.example.net/team/repo.git',
    })).rejects.toMatchObject({ code: 'PROJECT_CLONE_FAILED' })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
    expect([...memory.directories].some((path) => path.includes('.aisy-quarantine-'))).toBe(true)
    expect([...memory.files.values()].join('\n')).not.toContain('git stderr secret')
  })

  it('quarantines a cloned tree rejected by confinement and never publishes it', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: {
        scanRoot: async () => { throw new Error('SYMLINK_DENIED') },
      },
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'unsafe-tree-clone',
      clone: {
        dns: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
        transport: {
          clone: async ({ stagingRoot }) => {
            memory.fs.writeFileExclusive(`${stagingRoot}/README.md`, '# untrusted\n')
          },
        },
      },
    })

    await expect(provisioner.cloneProject({
      ...OWNER,
      name: 'Clone',
      url: 'https://git.example.net/team/repo.git',
    })).rejects.toMatchObject({ code: 'PROJECT_CLONE_FAILED' })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
    expect(memory.directories.has(`${PROJECTS_ROOT}/clone`)).toBe(false)
    expect([...memory.directories].some((path) => path.includes('.aisy-quarantine-'))).toBe(true)
  })

  it('gives one winner and one reservation failure for concurrent same-slug clone', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    let sequence = 0
    let releaseTransport: (() => void) | undefined
    const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve })
    let announceTransport: (() => void) | undefined
    const transportStarted = new Promise<void>((resolve) => { announceTransport = resolve })
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => `concurrent-clone-${++sequence}`,
      clone: {
        dns: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
        transport: {
          clone: async ({ stagingRoot }) => {
            announceTransport?.()
            await transportGate
            memory.fs.writeFileExclusive(`${stagingRoot}/README.md`, '# cloned\n')
          },
        },
      },
    })

    const first = provisioner.cloneProject({
      ...OWNER,
      name: 'Clone',
      url: 'https://git.example.net/team/repo.git',
    })
    await transportStarted
    const second = provisioner.cloneProject({
      ...OWNER,
      name: 'Clone',
      url: 'https://git.example.net/team/repo.git',
    })
    releaseTransport?.()
    const results = await Promise.allSettled([first, second])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'PROJECT_ROOT_RESERVED' })
    expect(registry.listContexts(OWNER).filter((item) => item.slug === 'clone')).toHaveLength(1)
  })

  it('gives one winner and one deterministic reservation failure for concurrent same-slug create', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    let sequence = 0
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => `create-${++sequence}`,
    })

    const results = await Promise.allSettled([
      provisioner.createProject({ ...OWNER, name: 'Project B' }),
      provisioner.createProject({ ...OWNER, name: 'Project B' }),
    ])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'PROJECT_ROOT_RESERVED' })
    expect(registry.listContexts(OWNER).filter((item) => item.slug === 'project-b')).toHaveLength(1)
  })

  it('quarantines partial staging and publishes no project on layout failure', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs({ failLayoutWrite: true })
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'layout-failure',
    })

    await expect(provisioner.createProject({ ...OWNER, name: 'Project B' })).rejects.toMatchObject({
      code: 'PROJECT_CREATE_FAILED',
    })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
    expect([...memory.directories].some((path) => path.includes('.aisy-quarantine-'))).toBe(true)
    expect(memory.directories.has(`${PROJECTS_ROOT}/project-b`)).toBe(false)
    expect([...memory.directories].some((path) => path.startsWith(RESERVATIONS_ROOT + '/'))).toBe(false)
  })

  it('quarantines staging and publishes no project when confinement scan rejects it', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: {
        scanRoot: async () => { throw new Error('SYMLINK_DENIED') },
      },
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'scan-failure',
    })

    await expect(provisioner.createProject({ ...OWNER, name: 'Project B' })).rejects.toMatchObject({
      code: 'PROJECT_CREATE_FAILED',
    })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
    expect(memory.directories.has(`${PROJECTS_ROOT}/project-b`)).toBe(false)
    expect([...memory.directories].some((path) => path.includes('.aisy-quarantine-'))).toBe(true)
  })

  it('quarantines the final root when atomic registry persistence fails', async () => {
    const { registry, service } = runtime({ failRegistry: true })
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'registry-failure',
    })

    await expect(provisioner.createProject({ ...OWNER, name: 'Project B' })).rejects.toMatchObject({
      code: 'PROJECT_CREATE_FAILED',
    })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
    expect(memory.directories.has(`${PROJECTS_ROOT}/project-b`)).toBe(false)
    expect([...memory.directories].some((path) => path.includes('.aisy-quarantine-'))).toBe(true)
  })

  it('quarantines staging and publishes no project when final rename fails', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs({ failFinalRename: true })
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'rename-failure',
    })

    await expect(provisioner.createProject({ ...OWNER, name: 'Project B' })).rejects.toMatchObject({
      code: 'PROJECT_CREATE_FAILED',
    })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
    expect(memory.directories.has(`${PROJECTS_ROOT}/project-b`)).toBe(false)
    expect([...memory.directories].some((path) => path.includes('.aisy-quarantine-'))).toBe(true)
  })

  it('keeps a durable recovery reservation when quarantine itself fails', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs({ failLayoutWrite: true, failQuarantineRename: true })
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'quarantine-failure',
    })

    await expect(provisioner.createProject({ ...OWNER, name: 'Project B' })).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINE_FAILED',
    })
    expect(registry.listContexts(OWNER).filter((item) => item.kind === 'project')).toHaveLength(0)
    const reservation = [...memory.files].find(([path]) => path.endsWith('/reservation.json'))
    expect(reservation?.[1]).toContain(`"finalRoot": "${PROJECTS_ROOT}/project-b"`)
    expect([...memory.directories].some((path) => path.startsWith(RESERVATIONS_ROOT + '/'))).toBe(true)
  })

  it('keeps the authoritative project successful and reports derived catalog repair', async () => {
    const { registry, service } = runtime()
    const memory = memoryFs({ failCatalog: true })
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'catalog-failure',
    })

    const result = await provisioner.createProject({ ...OWNER, name: 'Project B' })

    expect(result.catalogAudit).toBe('pending-repair')
    expect(registry.getActive(OWNER)).toEqual(result.selection)
    expect(memory.directories.has(result.root)).toBe(true)
  })

  it('rejects unsafe explicit slugs before touching the filesystem', async () => {
    const { service } = runtime()
    const memory = memoryFs()
    const provisioner = makeProjectProvisioner({
      service,
      fs: memory.fs,
      treeScanner: scanner(),
      projectsRoot: PROJECTS_ROOT,
      controlRoot: CONTROL_ROOT,
      newId: () => 'unused',
    })

    for (const slug of ['../escape', '-option', 'UPPER', 'a/b', 'a'.repeat(64)]) {
      await expect(provisioner.createProject({
        ...OWNER,
        name: 'Unsafe',
        slug,
      })).rejects.toMatchObject({ code: 'INVALID_PROJECT_SLUG' })
    }
    expect(memory.calls).toEqual([])
  })

  it('renders PROJECTS.md deterministically without roots or private content', () => {
    const { service } = runtime()
    const contexts = service.listContexts(OWNER)
    const rendered = renderProjectsCatalog(contexts)
    expect(rendered).toContain('# Проекты Aisy')
    expect(rendered).toContain('Workspace | Workspace | активен')
    expect(rendered).not.toContain(WORKSPACE_ROOT)
  })
})

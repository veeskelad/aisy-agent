import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeGrantStore,
  makeProjectRegistryV2,
  makeProjectService,
  makeSwitchAuthority,
  type ConfinementPort,
} from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'

import { makeCodexCapabilityTurnRuntime } from './codex-capability-runtime.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }

describe('Codex app capability runtime', () => {
  it('executes approved effects only in the exact durable Project binding', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-capability-')))
    const workspaceRoot = join(root, 'workspace')
    const projectsRoot = join(root, 'projects')
    const projectRoot = join(projectsRoot, 'project-a')
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 })
    writeFileSync(join(projectRoot, 'README.md'), 'project-a', { mode: 0o600 })

    let registryId = 0
    const policy = { homeRoot: root, projectsRoot, protectedRoots: [join(root, '.aisy')] }
    const registry = makeProjectRegistryV2({
      state: makeFreshProjectRegistryV2({
        ...OWNER, workspaceRoot, policy,
        nowIso: () => '2026-07-27T00:00:00.000Z',
        newId: () => `registry-${++registryId}`,
      }),
      policy,
      nowIso: () => '2026-07-27T00:00:00.000Z',
      newId: () => `registry-${++registryId}`,
    })
    const selected = registry.createProject({
      ...OWNER, name: 'Project A', slug: 'project-a', root: projectRoot, origin: 'created',
    })
    let leaseId = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
    const authority = makeSwitchAuthority({
      secret: Buffer.alloc(32, 7), nowMs: () => 1,
      newId: () => 'receipt-unused',
      nonces: { issue: () => {}, has: () => false, consume: () => false },
    })
    const service = makeProjectService({ registry, leases, authority })
    const confined = (leaseRoot: string, path: string): string => {
      const candidate = isAbsolute(path) ? resolve(path) : resolve(leaseRoot, path)
      if (candidate !== leaseRoot && !candidate.startsWith(`${leaseRoot}/`)) {
        throw new Error('outside lease')
      }
      return candidate
    }
    const confinement: ConfinementPort = {
      readText: async (lease, path) => readFileSync(confined(lease.root, path), 'utf8'),
      writeText: async (lease, path, text) => {
        writeFileSync(confined(lease.root, path), text, { mode: 0o600 })
        return Buffer.byteLength(text)
      },
      editText: async (lease, path, oldText, newText) => {
        const target = confined(lease.root, path)
        const current = readFileSync(target, 'utf8')
        if (!current.includes(oldText)) throw new Error('precondition')
        const updated = current.replace(oldText, newText)
        writeFileSync(target, updated, { mode: 0o600 })
        return { bytes: Buffer.byteLength(updated), replacements: 1 }
      },
      list: async (lease, path = '.') => readdirSync(confined(lease.root, path)),
      scan: async () => ({ entries: 0, files: 0, directories: 0, totalBytes: 0 }),
    }
    const binding = {
      ...OWNER,
      projectId: selected.projectId,
      sessionId: selected.sessionId,
      scope: 'project' as const,
    }
    const approve = vi.fn(async (
      _binding: typeof binding,
      _action: unknown,
      _signal: AbortSignal,
    ) => ({
      decision: 'confirmed' as const,
      scope: 'session' as const,
    }))
    const runtime = makeCodexCapabilityTurnRuntime({
      service,
      confinement,
      grants: makeGrantStore(),
      binding,
      threadId: 'thread-a',
      turnId: 'turn-a',
      context: { provenance: 'operator', narrowed: false },
      allowedTools: new Set(['read_file', 'write_file']),
      approve,
      executeNonFileTool: async () => ({ ok: false, output: 'unsupported' }),
    })

    await expect(runtime.invoke({
      threadId: 'thread-a', turnId: 'turn-a', itemId: 'read-1',
      tool: 'read_file', arguments: { path: 'README.md' },
    })).resolves.toEqual({ ok: true, output: 'project-a' })
    await expect(runtime.invoke({
      threadId: 'thread-a', turnId: 'turn-a', itemId: 'write-1',
      tool: 'write_file', arguments: { path: 'result.txt', content: 'verified effect' },
    })).resolves.toEqual({ ok: true, output: 'wrote 15 bytes' })

    expect(readFileSync(join(projectRoot, 'result.txt'), 'utf8')).toBe('verified effect')
    expect(existsSync(join(workspaceRoot, 'result.txt'))).toBe(false)
    expect(approve).toHaveBeenCalledTimes(1)
    expect(approve.mock.calls[0]?.[0]).toEqual(binding)
  })
})

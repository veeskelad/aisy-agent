import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import type { ToolExecutionContext } from '@aisy/core'
import { makeConversationalPolicyControl } from './conversational-policy-control.js'
import {
  makeMemoryProjectPolicyOverlayStore,
  makeNodeProjectPolicyOverlayStore,
  makeWorkspaceResourceAdmissionRegistry,
  resolveProjectPolicyResourcePath,
} from './project-policy-overlay.js'

const roots: string[] = []

function root(prefix: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('ProjectPolicyOverlayStore', () => {
  it('combines Project and deepest matching path restrictions without widening', () => {
    const store = makeMemoryProjectPolicyOverlayStore()
    expect(store.tighten({
      projectId: 'p1', relativePath: null, mode: 'confirm-writes', expectedRevision: 0,
    })).toBe('tightened')
    expect(store.tighten({
      projectId: 'p1', relativePath: 'private', mode: 'read-only', expectedRevision: 1,
    })).toBe('tightened')

    expect(store.evaluate({
      projectId: 'p1', tool: 'write_file', args: { path: 'public/a.txt' },
      effect: 'write', outboundSink: false, relativePath: 'public/a.txt',
    })).toEqual({ decision: 'ask', summary: 'Изменить данные в этом проекте?' })
    expect(store.evaluate({
      projectId: 'p1', tool: 'write_file', args: { path: 'private/a.txt' },
      effect: 'write', outboundSink: false, relativePath: 'private/a.txt',
    })).toEqual({ decision: 'deny' })
    expect(store.evaluate({
      projectId: 'p2', tool: 'write_file', args: { path: 'private/a.txt' },
      effect: 'write', outboundSink: false, relativePath: 'private/a.txt',
    })).toEqual({ decision: 'unchanged' })
  })

  it('makes no-egress and delete confirmation independent strict dimensions', () => {
    const store = makeMemoryProjectPolicyOverlayStore()
    store.tighten({
      projectId: 'p1', relativePath: null, mode: 'no-egress', expectedRevision: 0,
    })
    store.tighten({
      projectId: 'p1', relativePath: null, mode: 'ask-before-delete', expectedRevision: 1,
    })

    expect(store.evaluate({
      projectId: 'p1', tool: 'web_search', args: { query: 'x' },
      effect: 'read', outboundSink: true, relativePath: null,
    })).toEqual({ decision: 'deny' })
    expect(store.evaluate({
      projectId: 'p1', tool: 'bash', args: { cmd: 'curl https://example.test' },
      effect: 'execute', outboundSink: false, relativePath: null,
    })).toEqual({ decision: 'deny' })
    expect(store.evaluate({
      projectId: 'p1', tool: 'bash', args: { cmd: "python -c 'import socket'" },
      effect: 'execute', outboundSink: false, relativePath: null,
    })).toEqual({ decision: 'deny' })
    expect(store.evaluate({
      projectId: 'p1', tool: 'mcp:read:remote.lookup', args: {},
      effect: null, outboundSink: false, relativePath: null,
    })).toEqual({ decision: 'deny' })
    expect(store.evaluate({
      projectId: 'p1', tool: 'set_trigger',
      args: { kind: 'watch', probe: 'http:https://example.test' },
      effect: 'write', outboundSink: false, relativePath: null,
    })).toEqual({ decision: 'deny' })
    expect(store.evaluate({
      projectId: 'p1', tool: 'bash', args: { cmd: 'rm old.txt' },
      effect: 'execute', outboundSink: false, relativePath: null,
    })).toEqual({ decision: 'deny' })

    const deleteOnly = makeMemoryProjectPolicyOverlayStore()
    deleteOnly.tighten({
      projectId: 'p1', relativePath: null, mode: 'ask-before-delete', expectedRevision: 0,
    })
    expect(deleteOnly.evaluate({
      projectId: 'p1', tool: 'bash', args: { cmd: 'rm old.txt' },
      effect: 'execute', outboundSink: false, relativePath: null,
    })).toEqual({
      decision: 'ask',
      summary: 'Удалить выбранные данные? После этого вернуть их может быть нельзя.',
    })
    expect(store.evaluate({
      projectId: 'p1', tool: 'configure_agent',
      args: { operation: 'session.request-delete', target: 'current' },
      effect: 'write', outboundSink: false, relativePath: null,
    })).toEqual({ decision: 'unchanged' })

    const confirm = makeMemoryProjectPolicyOverlayStore()
    confirm.tighten({
      projectId: 'p1', relativePath: null, mode: 'confirm-writes', expectedRevision: 0,
    })
    expect(confirm.evaluate({
      projectId: 'p1', tool: 'configure_agent',
      args: { operation: 'session.request-delete', target: 'current' },
      effect: 'write', outboundSink: false, relativePath: null,
    })).toEqual({ decision: 'unchanged' })
  })

  it('uses CAS and persists a private restart-stable state', () => {
    const directory = root('aisy-policy-store-')
    const path = join(directory, 'policy.json')
    const first = makeNodeProjectPolicyOverlayStore({ path })
    expect(first.tighten({
      projectId: 'p1', relativePath: null, mode: 'read-only', expectedRevision: 0,
    })).toBe('tightened')
    expect(first.tighten({
      projectId: 'p1', relativePath: null, mode: 'no-egress', expectedRevision: 0,
    })).toBe('stale')

    const restarted = makeNodeProjectPolicyOverlayStore({ path })
    expect(restarted.snapshot()).toEqual(first.snapshot())
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ revision: 1 })
    expect(restarted.relax({
      projectId: 'p1', relativePath: null, mode: 'read-only', expectedRevision: 1,
    })).toBe('relaxed')
    expect(makeNodeProjectPolicyOverlayStore({ path }).snapshot()).toMatchObject({
      revision: 2, overlays: [],
    })
  })

  it('fails closed when a crash fence remains beside the canonical state', () => {
    const directory = root('aisy-policy-fence-')
    const path = join(directory, 'policy.json')
    writeFileSync(`${path}.safe`, '{"schemaVersion":1,"state":"fenced"}\n', { mode: 0o600 })

    expect(() => makeNodeProjectPolicyOverlayStore({ path }))
      .toThrow('CORRUPT_PROJECT_POLICY_STORE')
  })

  it('uses one canonical no-symlink resource identity for matching and execution', () => {
    const projectRoot = root('aisy-policy-resource-')
    mkdirSync(join(projectRoot, 'docs', 'private'), { recursive: true })
    symlinkSync(join(projectRoot, 'docs', 'private'), join(projectRoot, 'alias'), 'dir')

    expect(resolveProjectPolicyResourcePath(
      projectRoot,
      'docs/private/../private/new.txt',
    )).toMatchObject({
      absolutePath: join(projectRoot, 'docs', 'private', 'new.txt'),
      relativePath: 'docs/private/new.txt',
    })
    expect(resolveProjectPolicyResourcePath(projectRoot, '././docs/private/new.txt'))
      .toMatchObject({ relativePath: 'docs/private/new.txt' })
    expect(resolveProjectPolicyResourcePath(projectRoot, 'alias/new.txt')).toBeNull()
  })

  it('derives matching identity from the actual directory entry spelling', () => {
    const directory = (inode: bigint) => ({
      dev: 1n, ino: inode, isDirectory: () => true, isSymbolicLink: () => false,
    })
    const missing = (): never => {
      const error = new Error('missing') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    const real = new Map([
      ['/project', '/project'],
      ['/project/docs', '/project/docs'],
      ['/project/docs/private', '/project/docs/private'],
    ])
    const inodes = new Map([
      ['/project', 1n],
      ['/project/DOCS', 2n], ['/project/docs', 2n],
      ['/project/docs/PRIVATE', 3n], ['/project/docs/private', 3n],
    ])
    const fs = {
      realpath: (path: string) => real.get(path) ?? missing(),
      lstat: (path: string) => path.endsWith('/new.txt')
        ? missing()
        : directory(inodes.get(path) ?? 99n),
      readdir: (path: string) => path === '/project' ? ['docs'] : ['private'],
    }

    expect(resolveProjectPolicyResourcePath(
      '/project',
      'DOCS/PRIVATE/new.txt',
      fs,
    )).toMatchObject({
      absolutePath: '/project/docs/private/new.txt',
      relativePath: 'docs/private/new.txt',
    })
  })

  it('cannot bypass an overlay with a case alias on a case-insensitive filesystem', () => {
    const projectRoot = root('aisy-policy-case-')
    mkdirSync(join(projectRoot, 'MixedCase'))
    const caseAlias = join(projectRoot, 'mixedcase')

    const resolved = resolveProjectPolicyResourcePath(projectRoot, 'mixedcase/new.txt')
    if (!existsSync(caseAlias)) {
      expect(resolved).toBeNull()
      return
    }
    expect(resolved).toMatchObject({
      absolutePath: join(projectRoot, 'MixedCase', 'new.txt'),
      relativePath: 'MixedCase/new.txt',
    })
  })

  it('invalidates admission when an ordinary directory is swapped before execution', () => {
    const projectRoot = root('aisy-policy-admission-swap-')
    mkdirSync(join(projectRoot, 'open'))
    mkdirSync(join(projectRoot, 'strict'))
    writeFileSync(join(projectRoot, 'open', 'data.txt'), 'open')
    writeFileSync(join(projectRoot, 'strict', 'data.txt'), 'strict')
    const admissions = makeWorkspaceResourceAdmissionRegistry({ root: projectRoot })
    const context = { sessionId: 's1', turnId: 't1', ordinal: 1 }

    expect(admissions.admit(context, 'write_file', 'open/data.txt'))
      .toEqual({ relativePath: 'open/data.txt' })
    renameSync(join(projectRoot, 'open'), join(projectRoot, 'open-old'))
    renameSync(join(projectRoot, 'strict'), join(projectRoot, 'open'))

    expect(admissions.consume(context, 'write_file', 'open/data.txt')).toBeNull()
    expect(admissions.consume(context, 'write_file', 'open/data.txt')).toBeNull()
  })
})

describe('makeConversationalPolicyControl', () => {
  function setup() {
    const projectRoot = root('aisy-policy-project-')
    mkdirSync(join(projectRoot, 'docs', 'private'), { recursive: true })
    const outside = root('aisy-policy-outside-')
    symlinkSync(outside, join(projectRoot, 'escape'), 'dir')
    const store = makeMemoryProjectPolicyOverlayStore()
    let sessionId = 's1'
    const handles = ['folder-1', 'folder-2', 'folder-3']
    const control = makeConversationalPolicyControl({
      projectId: 'p1', projectRoot, currentSessionId: () => sessionId, store,
      newHandle: () => handles.shift() ?? 'folder-n',
    })
    const context: ToolExecutionContext = {
      sessionId, turnId: 'turn-1', ordinal: 1, signal: new AbortController().signal,
    }
    return {
      control, context, store, projectRoot, outside,
      resolvePath: (value: string, turn = context) => control.configure({
        operation: 'policy.resolve-path', target: 'current', value,
      }, turn).output,
      setSession: (value: string) => { sessionId = value },
    }
  }

  it('resolves a real directory to one-turn authority and tightens it immediately', () => {
    const h = setup()
    expect(h.resolvePath('docs/private')).toBe('• folder-1 — docs/private')
    expect(h.control.describeRelaxation({
      name: 'configure_agent',
      args: { operation: 'policy.relax-path', target: 'folder-1', value: 'read-only' },
    }, {
      provenance: 'operator', narrowed: false, sessionId: 's1', turnId: 'turn-1',
    })).toEqual({ scope: 'path', relativePath: 'docs/private' })
    expect(h.control.configure({
      operation: 'policy.tighten-path', target: 'folder-1', value: 'read-only',
    }, h.context)).toEqual({
      ok: true,
      output: 'Настроил: в папке docs/private — только чтение.',
      outcome: 'policy-tightened',
    })
    expect(h.store.evaluate({
      projectId: 'p1', tool: 'write_file', args: { path: 'docs/private/a' },
      effect: 'write', outboundSink: false, relativePath: 'docs/private/a',
    })).toEqual({ decision: 'deny' })
  })

  it('rejects symlinks, escapes, replay, stale revision and another session', () => {
    const h = setup()
    expect(h.resolvePath('escape')).toContain('Символические ссылки')
    expect(h.resolvePath('../outside')).toContain('Не нашёл')

    expect(h.resolvePath('docs')).toBe('• folder-1 — docs')
    const nextTurn = { ...h.context, turnId: 'turn-2', ordinal: 2 }
    expect(h.control.configure({
      operation: 'policy.tighten-path', target: 'folder-1', value: 'read-only',
    }, nextTurn)).toMatchObject({ ok: false })

    expect(h.resolvePath('docs')).toBe('• folder-2 — docs')
    h.store.tighten({
      projectId: 'p1', relativePath: null, mode: 'confirm-writes', expectedRevision: 0,
    })
    expect(h.control.configure({
      operation: 'policy.tighten-path', target: 'folder-2', value: 'read-only',
    }, h.context)).toMatchObject({ ok: false })

    expect(h.resolvePath('docs')).toBe('• folder-3 — docs')
    h.setSession('s2')
    expect(h.control.configure({
      operation: 'policy.tighten-path', target: 'folder-3', value: 'read-only',
    }, h.context)).toMatchObject({ ok: false })
  })

  it('rejects a directory swapped to a symlink after issuing the handle', () => {
    const h = setup()
    expect(h.resolvePath('docs/private')).toBe('• folder-1 — docs/private')
    renameSync(join(h.projectRoot, 'docs'), join(h.projectRoot, 'docs-old'))
    symlinkSync(h.outside, join(h.projectRoot, 'docs'), 'dir')

    expect(h.control.configure({
      operation: 'policy.tighten-path', target: 'folder-1', value: 'read-only',
    }, h.context)).toMatchObject({ ok: false })
    expect(h.store.snapshot().overlays).toEqual([])
  })

  it('rolls a relaxation back when the directory swaps during publication', () => {
    const projectRoot = root('aisy-policy-race-')
    const outside = root('aisy-policy-race-outside-')
    mkdirSync(join(projectRoot, 'docs', 'private'), { recursive: true })
    let swapped = false
    const store = makeMemoryProjectPolicyOverlayStore({
      initial: {
        schemaVersion: 1,
        revision: 1,
        overlays: [{ projectId: 'p1', relativePath: 'docs/private', modes: ['read-only'] }],
      },
      save: (state) => {
        if (state.revision === 2 && !swapped) {
          swapped = true
          renameSync(join(projectRoot, 'docs'), join(projectRoot, 'docs-old'))
          symlinkSync(outside, join(projectRoot, 'docs'), 'dir')
        }
      },
    })
    const control = makeConversationalPolicyControl({
      projectId: 'p1', projectRoot, currentSessionId: () => 's1', store,
      newHandle: () => 'folder-race',
    })
    const context: ToolExecutionContext = {
      sessionId: 's1', turnId: 'turn-race', ordinal: 1,
      signal: new AbortController().signal,
    }
    expect(control.configure({
      operation: 'policy.resolve-path', target: 'current', value: 'docs/private',
    }, context)).toMatchObject({ ok: true, outcome: 'policy-path-resolved' })

    expect(control.configure({
      operation: 'policy.relax-path', target: 'folder-race', value: 'read-only',
    }, context)).toEqual({
      ok: false,
      output: 'Папка изменилась во время настройки. Строгий режим сохранён.',
    })
    expect(store.snapshot()).toMatchObject({
      revision: 3,
      overlays: [{ projectId: 'p1', relativePath: 'docs/private', modes: ['read-only'] }],
    })
  })

  it('allows only meaningful folder modes and project-wide strict policies', () => {
    const h = setup()
    expect(h.resolvePath('docs')).toBe('• folder-1 — docs')
    expect(h.control.configure({
      operation: 'policy.tighten-path', target: 'folder-1', value: 'no-egress',
    }, h.context)).toEqual({
      ok: false, output: 'Этот режим можно включить только для проекта целиком.',
    })
    expect(h.control.configure({
      operation: 'policy.tighten-project', target: 'current', value: 'no-egress',
    }, h.context)).toMatchObject({ ok: true, outcome: 'policy-tightened' })
    expect(h.resolvePath('.')).toContain(
      '• весь проект — без внешних подключений',
    )
    expect(h.resolvePath('.')).not.toContain('folder-')
    expect(h.control.configure({
      operation: 'policy.tighten-path', target: 'folder-2', value: 'read-only',
    }, h.context)).toMatchObject({ ok: false })
    expect(h.control.configure({
      operation: 'policy.relax-project', target: 'current', value: 'no-egress',
    }, h.context)).toMatchObject({ ok: true, outcome: 'policy-relaxed' })
  })

  it('does not describe forged, stale or cross-turn relaxation handles', () => {
    const h = setup()
    expect(h.resolvePath('docs/private')).toBe('• folder-1 — docs/private')
    const call = {
      name: 'configure_agent',
      args: { operation: 'policy.relax-path', target: 'folder-1', value: 'read-only' },
    }
    expect(h.control.describeRelaxation({ ...call, args: { ...call.args, target: 'forged' } }, {
      provenance: 'operator', narrowed: false, sessionId: 's1', turnId: 'turn-1',
    })).toBeNull()
    expect(h.control.describeRelaxation(call, {
      provenance: 'operator', narrowed: false, sessionId: 's1', turnId: 'turn-2',
    })).toBeNull()
    h.store.tighten({
      projectId: 'p1', relativePath: null, mode: 'confirm-writes', expectedRevision: 0,
    })
    expect(h.control.describeRelaxation(call, {
      provenance: 'operator', narrowed: false, sessionId: 's1', turnId: 'turn-1',
    })).toBeNull()
  })

  it('keeps a folder literally named like the Project label as path scope', () => {
    const h = setup()
    mkdirSync(join(h.projectRoot, 'весь проект'))
    expect(h.resolvePath('весь проект')).toBe('• folder-1 — весь проект')
    expect(h.control.describeRelaxation({
      name: 'configure_agent',
      args: { operation: 'policy.relax-path', target: 'folder-1', value: 'read-only' },
    }, {
      provenance: 'operator', narrowed: false, sessionId: 's1', turnId: 'turn-1',
    })).toEqual({ scope: 'path', relativePath: 'весь проект' })
  })
})

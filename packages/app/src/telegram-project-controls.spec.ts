import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  type SwitchAuthorityBinding,
} from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import {
  makeTelegramProjectControls,
  TelegramProjectControlsError,
  type TelegramProjectButton,
} from './telegram-project-controls.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const NOW = Date.parse('2026-07-27T08:00:00.000Z')

function setup(projectNames: string[] = ['Project A']) {
  const root = '/Users/operator'
  const policy = {
    homeRoot: root,
    projectsRoot: join(root, 'projects'),
    protectedRoots: [join(root, '.aisy')],
  }
  let id = 0
  let durable = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: join(root, 'workspace'),
    nowIso: () => new Date(NOW).toISOString(),
    newId: () => `id-${++id}`,
    policy,
  })
  const registry = makeProjectRegistryV2({
    state: durable,
    policy,
    nowIso: () => new Date(NOW).toISOString(),
    newId: () => `id-${++id}`,
    persistence: { saveAtomic: (state) => { durable = state } },
  })
  for (const name of projectNames) {
    const slug = name.toLowerCase().replaceAll(' ', '-')
    registry.createProject({
      ...OWNER,
      name,
      slug,
      root: join(policy.projectsRoot, slug),
      origin: 'created',
    })
  }
  let issued: SwitchAuthorityBinding | undefined
  const runtime = {
    registry,
    authority: {
      issue(binding: SwitchAuthorityBinding) {
        issued = binding
        return Object.freeze({ ...binding })
      },
    },
    service: {
      async switchContext(input: {
        operatorId: string
        profileId: string
        targetProjectId: string
        sourceMessageHash: string
      }) {
        if (!issued || issued.operatorId !== input.operatorId ||
          issued.profileId !== input.profileId ||
          issued.targetProjectId !== input.targetProjectId ||
          issued.sourceMessageHash !== input.sourceMessageHash) {
          throw new Error('invalid binding')
        }
        const expectedGeneration = issued.expectedGeneration
        issued = undefined
        return {
          selection: registry.switchContext({
            ...OWNER,
            projectId: input.targetProjectId,
            expectedGeneration,
          }),
        }
      },
    },
  } as unknown as Pick<NodeProjectServiceRuntime, 'registry' | 'authority' | 'service'>
  return { root, runtime }
}

function findButton(rows: TelegramProjectButton[][], text: string): TelegramProjectButton {
  const button = rows.flat().find((candidate) => candidate.text.includes(text))
  if (!button) throw new Error(`missing button: ${text}`)
  return button
}

describe('makeTelegramProjectControls', () => {
  it('switches through a generation-bound one-use callback and rejects replay', async () => {
    const { root, runtime } = setup()
    let token = 0
    const controls = makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      newTokenId: () => `token-${++token}`,
      displayRoot: (path) => path.replace(root, '$ROOT'),
    })
    const before = runtime.registry.getActive(OWNER)
    const view = await controls.open()
    const workspace = findButton(view.buttons, 'Workspace')

    const switched = await controls.handle(workspace.data)

    expect(switched).toMatchObject({
      kind: 'switched',
      selection: { generation: before.generation + 1 },
    })
    if (switched.kind !== 'switched') throw new Error('expected switched outcome')
    expect(switched.text).toContain('Корень: $ROOT/workspace')
    const after = runtime.registry.getActive(OWNER)
    expect(after.projectId).not.toBe(before.projectId)

    await expect(controls.handle(workspace.data)).resolves.toMatchObject({ kind: 'stale' })
    expect(runtime.registry.getActive(OWNER)).toEqual(after)
  })

  it('fails closed when the active generation changes after rendering', async () => {
    const { runtime } = setup(['Project A', 'Project B'])
    let token = 0
    const controls = makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      newTokenId: () => `token-${++token}`,
    })
    const view = await controls.open()
    const oldWorkspaceButton = findButton(view.buttons, 'Workspace')
    const active = runtime.registry.getActive(OWNER)
    const other = runtime.registry.listContexts(OWNER)
      .find((context) => context.id !== active.projectId)!
    runtime.registry.switchContext({
      ...OWNER,
      projectId: other.id,
      expectedGeneration: active.generation,
    })
    const changed = runtime.registry.getActive(OWNER)

    await expect(controls.handle(oldWorkspaceButton.data)).resolves.toMatchObject({ kind: 'stale' })
    expect(runtime.registry.getActive(OWNER)).toEqual(changed)
  })

  it('paginates deterministically and invalidates buttons from the previous render', async () => {
    const { runtime } = setup(['Delta', 'Alpha', 'Charlie', 'Bravo'])
    let token = 0
    const controls = makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      pageSize: 2,
      newTokenId: () => `token-${++token}`,
    })
    const first = await controls.open()
    expect(first.buttons.slice(0, 2).flat().map((button) => button.text)).toEqual([
      '🏠 Workspace',
      '📁 Alpha',
    ])
    const next = findButton(first.buttons, '▶️')
    const second = await controls.handle(next.data)
    expect(second).toMatchObject({ kind: 'view' })
    if (second.kind !== 'view') throw new Error('expected view outcome')
    expect(second.view.buttons.slice(0, 2).flat().map((button) => button.text)).toEqual([
      '✅ Bravo',
      '📁 Charlie',
    ])
    expect(findButton(second.view.buttons, '2/3').text).toBe('2/3')

    await expect(controls.handle(next.data)).resolves.toMatchObject({ kind: 'stale' })
  })

  it('rejects invalid configuration and duplicate opaque tokens', async () => {
    const { runtime } = setup()
    expect(() => makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      pageSize: 0,
    })).toThrowError(new TelegramProjectControlsError('INVALID_CONFIGURATION'))

    const collision = makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      newTokenId: () => 'same-token',
    })
    await expect(collision.open()).rejects.toThrowError(
      new TelegramProjectControlsError('TOKEN_COLLISION'),
    )
  })

  it('never revives a token retired by a previous render', async () => {
    const { runtime } = setup()
    const ids = ['old-a', 'old-b', 'old-c', 'old-d', 'old-a']
    const controls = makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      newTokenId: () => ids.shift() ?? 'unused',
    })
    await controls.open()

    await expect(controls.open()).rejects.toThrowError(
      new TelegramProjectControlsError('TOKEN_COLLISION'),
    )
  })

  it('routes Russian and English authenticated selections through the same service', async () => {
    const { runtime } = setup(['Project A', 'Project B'])
    let token = 0
    const controls = makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      newTokenId: () => `token-${++token}`,
    })
    const before = runtime.registry.getActive(OWNER)

    const russian = await controls.handleAuthenticatedText({
      text: 'работаем над «Project A»', chatId: 42, updateId: 101,
    })
    expect(russian).toMatchObject({
      kind: 'switched',
      selection: { projectId: expect.any(String), generation: before.generation + 1 },
    })
    if (!russian || russian.kind !== 'switched') throw new Error('Russian switch expected')
    const selectedA = runtime.registry.getActive(OWNER)
    expect(runtime.registry.listContexts(OWNER).find((item) => item.id === selectedA.projectId)?.name)
      .toBe('Project A')

    const english = await controls.handleAuthenticatedText({
      text: 'switch to project-b', chatId: 42, updateId: 102,
    })
    expect(english).toMatchObject({
      kind: 'switched',
      selection: { generation: selectedA.generation + 1 },
    })
    const selectedB = runtime.registry.getActive(OWNER)
    expect(runtime.registry.listContexts(OWNER).find((item) => item.id === selectedB.projectId)?.name)
      .toBe('Project B')
  })

  it('shows owner-bound choices for an ambiguous exact name without mutation', async () => {
    const { runtime } = setup(['Twin'])
    runtime.registry.createProject({
      ...OWNER,
      name: 'TWIN',
      slug: 'twin-second',
      root: '/Users/operator/projects/twin-second',
      origin: 'created',
    })
    let token = 0
    const controls = makeTelegramProjectControls({
      runtime,
      owner: OWNER,
      newTokenId: () => `token-${++token}`,
    })
    const before = runtime.registry.getActive(OWNER)

    const outcome = await controls.handleAuthenticatedText({
      text: 'work on twin', chatId: 42, updateId: 103,
    })

    expect(outcome).toMatchObject({ kind: 'view' })
    if (!outcome || outcome.kind !== 'view') throw new Error('choice view expected')
    expect(outcome.view.buttons).toHaveLength(2)
    expect(outcome.view.buttons.flat().every((button) => button.data.startsWith('project:'))).toBe(true)
    expect(runtime.registry.getActive(OWNER)).toEqual(before)
  })

  it('does not consume ordinary text and asks one question for an unknown exact target', async () => {
    const { runtime } = setup()
    const controls = makeTelegramProjectControls({ runtime, owner: OWNER })

    await expect(controls.handleAuthenticatedText({
      text: 'расскажи о Project A', chatId: 42, updateId: 104,
    })).resolves.toBeNull()
    await expect(controls.handleAuthenticatedText({
      text: 'switch to Missing', chatId: 42, updateId: 105,
    })).resolves.toMatchObject({
      kind: 'unavailable',
      text: expect.stringContaining('Не нашёл контекст'),
    })
  })

  it('rejects a foreign or invalid transport identity before mutation', async () => {
    const { runtime } = setup(['Project A', 'Project B'])
    const controls = makeTelegramProjectControls({ runtime, owner: OWNER })
    const before = runtime.registry.getActive(OWNER)

    await expect(controls.handleAuthenticatedText({
      text: 'switch to Project A', chatId: 777, updateId: 106,
    })).rejects.toThrowError(new TelegramProjectControlsError('AUTHENTICATION_MISMATCH'))
    expect(runtime.registry.getActive(OWNER)).toEqual(before)
  })
})

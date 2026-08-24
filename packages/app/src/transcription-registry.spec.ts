import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  TranscriptionUnavailableError,
  inspectTranscriptionRegistry,
  makeTranscriptionRegistry,
  type TranscriptionProvider,
} from './transcription-registry.js'

const roots: string[] = []

function statePath(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-voice-')))
  roots.push(created)
  return join(created, 'transcription.json')
}

const transcript = (text: string) => ({
  text,
  provenance: 'untrusted' as const,
  channel: 'voice' as const,
})

const local = (over: Partial<TranscriptionProvider> = {}): TranscriptionProvider => ({
  id: 'whisper-local',
  label: 'Whisper в контейнере',
  audioLeavesHost: false,
  transcribe: async () => transcript('локальная расшифровка'),
  ...over,
})

const cloud = (over: Partial<TranscriptionProvider> = {}): TranscriptionProvider => ({
  id: 'cloud-stt',
  label: 'Облачный сервис',
  audioLeavesHost: true,
  privacyDisclosure: 'Аудио отправляется облачному сервису.',
  privacyRevision: 'cloud-stt-v1',
  transcribe: async () => transcript('облачная расшифровка'),
  ...over,
})

const request = {
  audioRoot: '/tmp/audio',
  relativePath: 'voice.ogg',
  expectedSha256: 'a'.repeat(64),
  expectedSizeBytes: 1024,
  maxBytes: 4096,
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('transcription provider registry (ADR-0085)', () => {
  it('shows the price of each choice in the list', () => {
    const registry = makeTranscriptionRegistry({
      providers: [local(), cloud()],
      path: statePath(),
    })

    expect(registry.list()).toEqual([
      { id: 'whisper-local', label: 'Whisper в контейнере', audioLeavesHost: false, selected: true },
      {
        id: 'cloud-stt', label: 'Облачный сервис', audioLeavesHost: true,
        privacyDisclosure: 'Аудио отправляется облачному сервису.',
        privacyRevision: 'cloud-stt-v1', selected: false,
      },
    ])
  })

  it('never selects a cloud provider on its own, even as the only one', async () => {
    const registry = makeTranscriptionRegistry({ providers: [cloud()], path: statePath() })

    expect(registry.selected()).toBeNull()
    await expect(registry.transcribe(request)).rejects.toThrowError(TranscriptionUnavailableError)
  })

  it('rejects duplicate provider ids before selection, persistence or external calls', () => {
    const path = statePath()
    const externalCall = vi.fn(async () => transcript('не должно выполниться'))
    const onSelect = vi.fn()

    expect(() => makeTranscriptionRegistry({
      providers: [
        local({ id: 'shared-id' }),
        cloud({ id: 'shared-id', transcribe: externalCall }),
      ],
      path,
      onSelect,
    })).toThrowError(new TranscriptionUnavailableError('invalid-provider-registry'))

    expect(externalCall).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })

  it('keeps an invalid provider registry distinct from a quarantined durable choice', () => {
    const provider = local({ id: 'duplicate' })

    expect(inspectTranscriptionRegistry({
      providers: [provider, local({ id: 'duplicate' })],
      path: statePath(),
    })).toEqual({ state: 'corrupt' })
  })

  it('uses a local provider without asking — nothing leaves the host', async () => {
    const registry = makeTranscriptionRegistry({ providers: [local()], path: statePath() })

    await expect(registry.transcribe(request)).resolves.toMatchObject({
      text: 'локальная расшифровка',
    })
  })

  it('uses one frozen provider snapshot after caller mutation', async () => {
    const candidate = local()
    const replacement = vi.fn(async () => transcript('внешняя подмена'))
    const registry = makeTranscriptionRegistry({ providers: [candidate], path: statePath() })

    candidate.audioLeavesHost = true
    candidate.privacyDisclosure = 'Аудио отправляется после скрытой подмены.'
    candidate.privacyRevision = 'hidden-revision-v1'
    candidate.transcribe = replacement

    expect(registry.list()).toEqual([
      { id: 'whisper-local', label: 'Whisper в контейнере', audioLeavesHost: false, selected: true },
    ])
    await expect(registry.transcribe(request)).resolves.toMatchObject({
      text: 'локальная расшифровка',
    })
    expect(replacement).not.toHaveBeenCalled()
  })

  it('uses one frozen dependency snapshot after caller mutation', () => {
    const originalPath = statePath()
    const replacementPath = statePath()
    const originalSelect = vi.fn()
    const replacementSelect = vi.fn()
    const providers = [local(), cloud()]
    const deps = { providers, path: originalPath, onSelect: originalSelect }
    const registry = makeTranscriptionRegistry(deps)

    deps.path = replacementPath
    deps.onSelect = replacementSelect
    providers.splice(0, providers.length, local())
    registry.select('cloud-stt')

    expect(existsSync(originalPath)).toBe(true)
    expect(existsSync(replacementPath)).toBe(false)
    expect(originalSelect).toHaveBeenCalledOnce()
    expect(replacementSelect).not.toHaveBeenCalled()
  })

  it('rejects proxy and accessor providers before registration', () => {
    const accessor = local()
    Object.defineProperty(accessor, 'audioLeavesHost', {
      configurable: true,
      enumerable: true,
      get: () => false,
    })

    for (const unsafe of [new Proxy(local(), {}), accessor]) {
      expect(() => makeTranscriptionRegistry({ providers: [unsafe], path: statePath() }))
        .toThrowError(new TranscriptionUnavailableError('invalid-provider-registry'))
    }
  })

  it('rejects proxy, accessor and non-canonical registry dependencies', () => {
    const path = statePath()
    const accessor = { providers: [local()], path }
    Object.defineProperty(accessor, 'path', {
      configurable: true,
      enumerable: true,
      get: () => path,
    })
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-voice-noncanonical-')))
    roots.push(root)
    mkdirSync(join(root, 'nested'), { mode: 0o700 })

    for (const unsafe of [
      new Proxy({ providers: [local()], path }, {}),
      accessor,
      { providers: [local()], path: `${root}/nested/../choice.json` },
    ]) {
      expect(() => makeTranscriptionRegistry(unsafe))
        .toThrowError(new TranscriptionUnavailableError('invalid-provider-registry'))
    }

    let iteratorCalls = 0
    const customIterable = [local()]
    Object.defineProperty(customIterable, Symbol.iterator, {
      value: () => {
        iteratorCalls += 1
        throw new Error('must not iterate caller code')
      },
    })
    expect(() => makeTranscriptionRegistry({ providers: customIterable, path }))
      .toThrowError(new TranscriptionUnavailableError('invalid-provider-registry'))
    expect(iteratorCalls).toBe(0)
  })

  it('sends audio out only after an explicit choice, and records it', async () => {
    const onSelect = vi.fn()
    const registry = makeTranscriptionRegistry({
      providers: [local(), cloud()],
      path: statePath(),
      onSelect,
    })

    registry.select('cloud-stt')

    await expect(registry.transcribe(request)).resolves.toMatchObject({
      text: 'облачная расшифровка',
    })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ audioLeavesHost: true }))
  })

  it('does not announce a local choice as if audio were leaving', () => {
    const onSelect = vi.fn()
    const registry = makeTranscriptionRegistry({
      providers: [local(), cloud()],
      path: statePath(),
      onSelect,
    })

    registry.select('whisper-local')

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps the choice across a restart', () => {
    const path = statePath()
    makeTranscriptionRegistry({ providers: [local(), cloud()], path }).select('cloud-stt')

    const reopened = makeTranscriptionRegistry({ providers: [local(), cloud()], path })

    expect(reopened.selected()?.id).toBe('cloud-stt')
  })

  it('requires renewed consent when an external privacy revision changes', async () => {
    const path = statePath()
    makeTranscriptionRegistry({ providers: [cloud()], path }).select('cloud-stt')
    const externalCall = vi.fn(async () => transcript('не должно выполниться'))
    const changedProvider = cloud({ privacyRevision: 'cloud-stt-v2', transcribe: externalCall })

    const reopened = makeTranscriptionRegistry({
      providers: [changedProvider], path,
    })

    expect(inspectTranscriptionRegistry({ providers: [changedProvider], path }))
      .toEqual({ state: 'quarantined' })
    expect(reopened.selected()).toBeNull()
    await expect(reopened.transcribe(request)).rejects.toEqual(
      new TranscriptionUnavailableError('no-provider-selected'),
    )
    expect(externalCall).not.toHaveBeenCalled()
  })

  it('invalidates consent when disclosure text changes without a revision bump', () => {
    const path = statePath()
    makeTranscriptionRegistry({ providers: [cloud()], path }).select('cloud-stt')

    const reopened = makeTranscriptionRegistry({
      providers: [cloud({ privacyDisclosure: 'Аудио теперь отправляется в другой регион.' })], path,
    })

    expect(reopened.selected()).toBeNull()
  })

  it('does not activate an external provider when consent cannot be persisted', () => {
    const blocked = statePath()
    writeFileSync(blocked, 'not a directory')
    const registry = makeTranscriptionRegistry({
      providers: [cloud()], path: join(blocked, 'choice.json'),
    })

    expect(() => registry.select('cloud-stt')).toThrowError(
      new TranscriptionUnavailableError('consent-not-durable'),
    )
    expect(registry.selected()).toBeNull()
  })

  it('keeps an externally published choice when directory durability is ambiguous', () => {
    const path = statePath()
    const registry = makeTranscriptionRegistry({
      providers: [local(), cloud()],
      path,
      syncDirectory: () => { throw new Error('injected post-rename failure') },
    })

    expect(registry.select('cloud-stt')).toMatchObject({ id: 'cloud-stt', selected: true })
    expect(registry.selected()?.id).toBe('cloud-stt')
    expect(makeTranscriptionRegistry({ providers: [local(), cloud()], path }).selected()?.id)
      .toBe('cloud-stt')
  })

  it('does not report local revocation when its durable overwrite is ambiguous', () => {
    const path = statePath()
    makeTranscriptionRegistry({ providers: [local(), cloud()], path }).select('cloud-stt')
    const registry = makeTranscriptionRegistry({
      providers: [local(), cloud()],
      path,
      syncDirectory: () => { throw new Error('injected post-rename failure') },
    })

    expect(() => registry.select('whisper-local')).toThrowError(
      new TranscriptionUnavailableError('consent-not-durable'),
    )
    expect(registry.selected()?.id).toBe('whisper-local')
    expect(makeTranscriptionRegistry({ providers: [local(), cloud()], path }).selected()?.id)
      .toBe('whisper-local')
  })

  it('falls back to local when the stored choice is unreadable or unknown', () => {
    const path = statePath()
    writeFileSync(path, JSON.stringify({ providerId: 'provider-that-left' }))

    expect(makeTranscriptionRegistry({ providers: [local(), cloud()], path }).selected()?.id)
      .toBe('whisper-local')
  })

  it('does not restore external consent from a permissive or symlinked state', () => {
    const permissivePath = statePath()
    makeTranscriptionRegistry({ providers: [local(), cloud()], path: permissivePath })
      .select('cloud-stt')
    chmodSync(permissivePath, 0o644)
    expect(makeTranscriptionRegistry({ providers: [local(), cloud()], path: permissivePath })
      .selected()?.id).toBe('whisper-local')

    const symlinkPath = statePath()
    makeTranscriptionRegistry({ providers: [local(), cloud()], path: symlinkPath })
      .select('cloud-stt')
    const target = `${symlinkPath}.target`
    renameSync(symlinkPath, target)
    symlinkSync(target, symlinkPath)
    expect(makeTranscriptionRegistry({ providers: [local(), cloud()], path: symlinkPath })
      .selected()?.id).toBe('whisper-local')
  })

  it('does not restore external consent through a non-private parent directory', () => {
    const path = statePath()
    makeTranscriptionRegistry({ providers: [local(), cloud()], path }).select('cloud-stt')
    chmodSync(dirname(path), 0o755)

    expect(makeTranscriptionRegistry({ providers: [local(), cloud()], path }).selected()?.id)
      .toBe('whisper-local')
  })

  it('refuses a provider that did not answer the question', () => {
    const registry = makeTranscriptionRegistry({
      providers: [
        { id: 'mystery', label: 'Неизвестно', transcribe: async () => transcript('x') } as never,
        local(),
      ],
      path: statePath(),
    })

    expect(registry.list().map((choice) => choice.id)).toEqual(['whisper-local'])
  })

  it('refuses an external provider without an exact disclosure revision', () => {
    const incomplete = cloud()
    delete incomplete.privacyDisclosure
    delete incomplete.privacyRevision
    const registry = makeTranscriptionRegistry({
      providers: [incomplete],
      path: statePath(),
    })

    expect(registry.list()).toEqual([])
  })

  it('refuses an unknown id instead of silently keeping the old one', () => {
    const registry = makeTranscriptionRegistry({ providers: [local()], path: statePath() })

    expect(() => registry.select('nope')).toThrowError(TranscriptionUnavailableError)
    expect(registry.selected()?.id).toBe('whisper-local')
  })
})

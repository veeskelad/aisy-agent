import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeProtectedMemoryFileStore,
  ProtectedMemoryFileStoreError,
  type ProtectedMemoryFileFault,
} from './protected-memory-file-store.js'

const roots: string[] = []
const OPERATION_ID = 'a'.repeat(64)
const SOURCE_PATH = `memory/facts/${'b'.repeat(64)}.md`
const CONTENT = Buffer.from('Надёжный защищённый факт', 'utf8')
const CONTENT_HASH = createHash('sha256').update(CONTENT).digest('hex')

function fixture(fault?: ProtectedMemoryFileFault) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-files-')))
  roots.push(root)
  const contentRoot = join(root, 'content')
  mkdirSync(contentRoot, { mode: 0o700 })
  let armed = fault
  const files = makeProtectedMemoryFileStore({
    contentRoot,
    stagingRoot: join(root, 'staging'),
    faultAt: (point) => {
      if (point !== armed) return
      armed = undefined
      throw new Error(`crash:${point}`)
    },
  })
  const request = {
    operationId: OPERATION_ID,
    sourcePath: SOURCE_PATH,
    contentHash: CONTENT_HASH,
    sizeBytes: CONTENT.byteLength,
  }
  return { contentRoot, files, request, root, stagingRoot: join(root, 'staging') }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('protected memory file store', () => {
  it('stages and installs an immutable private fact idempotently', async () => {
    const h = fixture()
    await h.files.stage({ ...h.request, content: CONTENT })

    await expect(h.files.install(h.request)).resolves.toBe('installed')
    await expect(h.files.verifyInstalled(h.request)).resolves.toBe(true)
    await expect(h.files.install(h.request)).resolves.toBe('already-installed')

    const target = join(h.contentRoot, SOURCE_PATH)
    expect(readFileSync(target)).toEqual(CONTENT)
    expect(lstatSync(target).mode & 0o777).toBe(0o600)
    expect(lstatSync(target).nlink).toBe(1)
    expect(existsSync(join(h.stagingRoot, `${OPERATION_ID}.fact`))).toBe(false)
  })

  it('recovers the hard-link boundary after a real process-style restart', async () => {
    const h = fixture('after-link')
    await h.files.stage({ ...h.request, content: CONTENT })
    await expect(h.files.install(h.request)).rejects.toThrow('crash:after-link')

    const restarted = makeProtectedMemoryFileStore({
      contentRoot: h.contentRoot,
      stagingRoot: h.stagingRoot,
    })
    await expect(restarted.install(h.request)).resolves.toBe('already-installed')
    await expect(restarted.verifyInstalled(h.request)).resolves.toBe(true)
    expect(lstatSync(join(h.contentRoot, SOURCE_PATH)).nlink).toBe(1)
  })

  it('discards an unpublished partial temp left by a crash during staging write', async () => {
    const h = fixture()
    const partial = join(h.stagingRoot, `${OPERATION_ID}.tmp-dead-process`)
    writeFileSync(partial, 'partial', { mode: 0o600 })

    await h.files.stage({ ...h.request, content: CONTENT })
    await expect(h.files.install(h.request)).resolves.toBe('installed')
    expect(existsSync(partial)).toBe(false)
    await expect(h.files.verifyInstalled(h.request)).resolves.toBe(true)
  })

  it('never overwrites a distinct target even when its bytes happen to match', async () => {
    const h = fixture()
    const target = join(h.contentRoot, SOURCE_PATH)
    writeFileSync(target, CONTENT, { mode: 0o600 })
    await h.files.stage({ ...h.request, content: CONTENT })

    await expect(h.files.install(h.request)).resolves.toBe('collision')
    expect(readFileSync(target)).toEqual(CONTENT)
    expect(existsSync(join(h.stagingRoot, `${OPERATION_ID}.fact`))).toBe(true)
  })

  it('fails closed for symlink targets and tampered staged content', async () => {
    const h = fixture()
    const outside = join(h.root, 'outside.md')
    writeFileSync(outside, CONTENT, { mode: 0o600 })
    symlinkSync(outside, join(h.contentRoot, SOURCE_PATH))
    await h.files.stage({ ...h.request, content: CONTENT })

    await expect(h.files.install(h.request)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    })
    await expect(h.files.verifyInstalled(h.request)).resolves.toBe(false)

    const staged = join(h.stagingRoot, `${OPERATION_ID}.fact`)
    rmSync(join(h.contentRoot, SOURCE_PATH))
    chmodSync(staged, 0o600)
    writeFileSync(staged, 'подмена', { mode: 0o600 })
    await expect(h.files.install(h.request)).resolves.toBe('collision')
  })

  it('rejects symlink roots and incorrect content hashes', async () => {
    const h = fixture()
    await expect(h.files.stage({
      ...h.request,
      content: CONTENT,
      contentHash: 'c'.repeat(64),
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' })

    const linked = join(h.root, 'linked-content')
    symlinkSync(h.contentRoot, linked, 'dir')
    expect(() => makeProtectedMemoryFileStore({
      contentRoot: linked,
      stagingRoot: join(h.root, 'other-staging'),
    })).toThrowError(ProtectedMemoryFileStoreError)
  })

  it('removes only the exact installed fact and recovers after unlink', async () => {
    const h = fixture('after-remove-target')
    await h.files.stage({ ...h.request, content: CONTENT })
    await h.files.install(h.request)
    await expect(h.files.removeInstalled(h.request)).rejects.toThrow('crash:after-remove-target')

    const restarted = makeProtectedMemoryFileStore({
      contentRoot: h.contentRoot,
      stagingRoot: h.stagingRoot,
    })
    await expect(restarted.verifyAbsent({ sourcePath: SOURCE_PATH })).resolves.toBe(true)
    await expect(restarted.removeInstalled(h.request)).resolves.toBeUndefined()
  })

  it('refuses to remove a live file whose expected identity does not match', async () => {
    const h = fixture()
    await h.files.stage({ ...h.request, content: CONTENT })
    await h.files.install(h.request)

    await expect(h.files.removeInstalled({
      ...h.request,
      contentHash: 'c'.repeat(64),
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' })
    await expect(h.files.verifyInstalled(h.request)).resolves.toBe(true)
  })
})

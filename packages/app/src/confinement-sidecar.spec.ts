import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfinementError, type ConfinementWorkerRequest } from '@aisy/core'
import { makeNodeConfinementProcessPort } from './confinement-sidecar.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function script(source: string, name = 'worker.mjs'): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-confinement-process-'))
  roots.push(root)
  const path = join(root, name)
  writeFileSync(path, source, { mode: 0o700 })
  return path
}

function request(): ConfinementWorkerRequest {
  return {
    version: 1,
    requestId: 'request-1',
    root: '/tmp/project',
    op: 'read',
    path: 'file.txt',
  }
}

describe('makeNodeConfinementProcessPort', () => {
  it('uses exact absolute executable and script arguments without a shell', async () => {
    const workerPath = script(`
      import { readFileSync } from 'node:fs'
      const input = JSON.parse(readFileSync(0, 'utf8'))
      process.stdout.write(JSON.stringify({
        version: 1,
        requestId: input.requestId,
        ok: true,
        data: { text: input.path, bytes: 8 },
      }))
    `, 'worker ; literal.mjs')
    const port = makeNodeConfinementProcessPort({
      pythonExecutable: process.execPath,
      workerPath,
    })

    await expect(port.run(request())).resolves.toMatchObject({
      version: 1,
      requestId: 'request-1',
      ok: true,
      data: { text: 'file.txt' },
    })
  })

  it('returns a structured denial emitted with exit code 2', async () => {
    const workerPath = script(`
      import { readFileSync } from 'node:fs'
      const input = JSON.parse(readFileSync(0, 'utf8'))
      process.stdout.write(JSON.stringify({
        version: 1,
        requestId: input.requestId,
        ok: false,
        error: { code: 'SYMLINK_DENIED' },
      }))
      process.exitCode = 2
    `)
    const port = makeNodeConfinementProcessPort({
      pythonExecutable: process.execPath,
      workerPath,
    })

    await expect(port.run(request())).resolves.toMatchObject({
      ok: false,
      error: { code: 'SYMLINK_DENIED' },
    })
  })

  it.each([
    ["process.stdout.write('not-json')", 'PROTOCOL_ERROR'],
    ["process.exitCode = 7", 'PROCESS_FAILED'],
    ["process.stderr.write('x'.repeat(17000))", 'PROCESS_FAILED'],
  ])('fails closed for malformed or noisy workers', async (source, code) => {
    const port = makeNodeConfinementProcessPort({
      pythonExecutable: process.execPath,
      workerPath: script(source),
    })

    await expect(port.run(request())).rejects.toEqual(new ConfinementError(code as never))
  })

  it('kills a worker after the bounded timeout', async () => {
    const port = makeNodeConfinementProcessPort({
      pythonExecutable: process.execPath,
      workerPath: script('setInterval(() => {}, 1000)'),
      timeoutMs: 20,
    })

    await expect(port.run(request())).rejects.toEqual(new ConfinementError('PROCESS_FAILED'))
  })

  it('requires canonical absolute code-owned executable and worker paths', () => {
    expect(() => makeNodeConfinementProcessPort({
      pythonExecutable: 'python3',
      workerPath: '/opt/aisy/worker.py',
    })).toThrow(new ConfinementError('INVALID_REQUEST'))
    expect(() => makeNodeConfinementProcessPort({
      pythonExecutable: process.execPath,
      workerPath: '/opt/aisy/../worker.py',
    })).toThrow(new ConfinementError('INVALID_REQUEST'))
  })
})

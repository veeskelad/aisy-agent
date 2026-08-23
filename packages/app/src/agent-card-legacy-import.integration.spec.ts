import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { makeNodeConfinementProcessPort } from './confinement-sidecar.js'
import {
  AgentCardLegacyImportError,
  makeAgentCardLegacyImportPort,
} from './agent-card-legacy-import.js'

const pythonExecutable = resolve(process.cwd(), '../sidecars-py/.venv/bin/python')
const workerPath = resolve(process.cwd(), '../sidecars-py/aisy_sidecars/confinement_worker.py')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.runIf(existsSync(pythonExecutable) && existsSync(workerPath))(
  'AgentCard legacy import Node to Python integration',
  () => {
    it('rejects root replacement after adapter construction', async () => {
      const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-legacy-real-')))
      roots.push(tempRoot)
      const root = join(tempRoot, 'agents')
      mkdirSync(root)
      writeFileSync(join(root, 'researcher.md'), '# researcher\n\nTrusted.', 'utf8')
      const port = makeAgentCardLegacyImportPort({
        root,
        process: makeNodeConfinementProcessPort({ pythonExecutable, workerPath }),
        newId: () => 'legacy-real-1',
      })

      renameSync(root, join(tempRoot, 'agents-detached'))
      mkdirSync(root)
      writeFileSync(join(root, 'researcher.md'), '# researcher\n\nReplacement.', 'utf8')

      await expect(port.readExact('researcher')).rejects.toEqual(
        new AgentCardLegacyImportError('PATH_CHANGED'),
      )
    })
  },
)

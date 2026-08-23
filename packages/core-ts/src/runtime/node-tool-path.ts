// Making Node-based CLIs runnable from a service-managed process.
//
// A systemd/launchd unit starts the agent with a minimal PATH — on a real host
// that is `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, with
// no trace of the Node installation. Every globally installed Node CLI (`npm`,
// `claude`, `codex`) is a symlink to a `.js` file whose shebang is
// `#!/usr/bin/env node`, so the kernel runs `env`, `env` searches that PATH,
// finds no `node`, and the spawn fails with a message about `node` that has
// nothing to do with the tool the operator asked for.
//
// Putting the directory of the running Node binary first fixes the shebang and
// the PATH lookup at once, for every such tool, without hard-coding a version.

import { delimiter, dirname } from 'node:path'

export function withNodeBinOnPath(
  env: NodeJS.ProcessEnv,
  nodeExecutablePath: string = process.execPath,
): NodeJS.ProcessEnv {
  const nodeBin = dirname(nodeExecutablePath)
  if (nodeBin.length === 0 || nodeBin === '.') return { ...env }
  const current = (env['PATH'] ?? '').split(delimiter).filter((part) => part.length > 0)
  // Already first: leave the string untouched rather than rebuild it, so an
  // operator-configured PATH stays byte-identical.
  if (current[0] === nodeBin) return { ...env }
  return {
    ...env,
    PATH: [nodeBin, ...current.filter((part) => part !== nodeBin)].join(delimiter),
  }
}

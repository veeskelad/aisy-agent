import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * PATH lookup that returns the canonical target of an optional CLI runtime.
 *
 * Two reasons this is not `input.executable = 'codex'`: the auth process ports
 * only accept an absolute realpath (a global npm bin is a symlink, so the raw
 * PATH hit is rejected), and a runtime that is simply not installed must be
 * reported as absent rather than blowing up the composition — the setup card
 * says "установи и повтори проверку", which it cannot do from a dead process.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (name.length === 0 || name.includes('/')) return null
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0 || !isAbsolute(dir)) continue
    try {
      const candidate = join(dir, name)
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      // Not here, not executable, or a broken link — keep walking PATH.
    }
  }
  return null
}

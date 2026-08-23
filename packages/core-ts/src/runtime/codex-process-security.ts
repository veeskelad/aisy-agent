import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'

import { withNodeBinOnPath } from './node-tool-path.js'

const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL',
  'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TERM', 'NO_COLOR',
] as const

function safeAbsolute(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && isAbsolute(value) && normalize(value) === value
}

/** Resolve only exact, owner-controlled paths; symlink aliases are rejected. */
export function canonicalCodexExecutable(value: string): string | null {
  if (!safeAbsolute(value)) return null
  try {
    const canonical = realpathSync(value)
    const stat = lstatSync(canonical)
    const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    accessSync(canonical, constants.X_OK)
    return canonical === value && stat.isFile() && !stat.isSymbolicLink() && ownerOk &&
      (stat.mode & 0o022) === 0 ? canonical : null
  } catch {
    return null
  }
}

export function canonicalCodexWorkingDirectory(value: string): string | null {
  if (!safeAbsolute(value)) return null
  try {
    const canonical = realpathSync(value)
    const stat = lstatSync(canonical)
    const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    return canonical === value && stat.isDirectory() && !stat.isSymbolicLink() && ownerOk &&
      (stat.mode & 0o022) === 0 ? canonical : null
  } catch {
    return null
  }
}

export function safeCodexEnvironment(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.length <= 8192 && !value.includes('\0')) result[key] = value
  }
  // The allowlist copies PATH verbatim, and under a service manager that PATH
  // has no Node — which the `codex` shebang needs before it can run at all.
  const path = withNodeBinOnPath(result)['PATH']
  if (typeof path === 'string') result['PATH'] = path
  return Object.freeze(result)
}

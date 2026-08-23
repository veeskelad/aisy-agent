// `.env` loader — the config file `aisy init` scaffolds into AISY_HOME.
//
// A fresh install has no vault: the operator's natural move is to fill in the
// `~/.aisy/.env` that init wrote for them. That file must therefore be a real
// config source at runtime, not decoration. It is the LOWEST-precedence layer:
// the vault (validated by init) wins, then the process environment, then this.

export function parseDotEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z0-9_]+$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    // Strip one layer of matching quotes — a Telegram token pasted from a chat
    // often arrives quoted, and a literal quote in the key would 401 silently.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) out[key] = value
  }
  return out
}

export type DotEnvLoadState =
  | { status: 'missing'; values: Record<string, never> }
  | { status: 'ready'; values: Record<string, string> }
  | { status: 'unavailable'; values: Record<string, never>; error: 'READ_FAILED' | 'MALFORMED' }

function isWellFormedDotEnv(body: string): boolean {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0 || !/^[A-Z0-9_]+$/.test(line.slice(0, eq).trim())) return false
    const value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && !value.endsWith('"')) ||
      (value.startsWith("'") && !value.endsWith("'"))) return false
  }
  return true
}

/** Missing is a valid empty layer; present-but-broken remains unavailable. */
export function loadDotEnvState(
  path: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string },
): DotEnvLoadState {
  if (!fs.existsSync(path)) return { status: 'missing', values: {} }
  let body: string
  try { body = fs.readFileSync(path, 'utf8') } catch {
    return { status: 'unavailable', values: {}, error: 'READ_FAILED' }
  }
  if (!isWellFormedDotEnv(body)) {
    return { status: 'unavailable', values: {}, error: 'MALFORMED' }
  }
  return { status: 'ready', values: parseDotEnv(body) }
}

/** Read and parse a `.env`; a missing or unreadable file is an empty layer. */
export function loadDotEnv(
  path: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string },
): Record<string, string> {
  return loadDotEnvState(path, fs).values
}

import type { DotEnvLoadState } from '@aisy/core'

export type JsonSecretSourceState =
  | { status: 'missing'; values: Record<string, never> }
  | { status: 'ready'; values: Record<string, string> }
  | { status: 'unavailable'; values: Record<string, never>; error: 'READ_FAILED' | 'MALFORMED' }

export function loadJsonSecretSource(
  path: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string },
): JsonSecretSourceState {
  if (!fs.existsSync(path)) return { status: 'missing', values: {} }
  let body: string
  try { body = fs.readFileSync(path, 'utf8') } catch {
    return { status: 'unavailable', values: {}, error: 'READ_FAILED' }
  }
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.values(value).some(item => typeof item !== 'string')) {
      return { status: 'unavailable', values: {}, error: 'MALFORMED' }
    }
    return { status: 'ready', values: value as Record<string, string> }
  } catch {
    return { status: 'unavailable', values: {}, error: 'MALFORMED' }
  }
}

const SECRET_KEY_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD)$/i

/** The PostToolUse source throws if any present config source was not readable. */
export function makeLiveSecretValues(input: {
  vault: JsonSecretSourceState
  dotenv: DotEnvLoadState
  processEnv: Readonly<Record<string, string | undefined>>
}): () => readonly string[] {
  return () => {
    if (input.vault.status === 'unavailable' || input.dotenv.status === 'unavailable') {
      throw new Error('SECRET_SOURCE_UNAVAILABLE')
    }
    return [...new Set([
      ...Object.values(input.vault.values),
      ...Object.entries(input.dotenv.values)
        .filter(([key]) => SECRET_KEY_NAME.test(key))
        .map(([, value]) => value),
      ...Object.entries(input.processEnv)
        .filter(([key]) => SECRET_KEY_NAME.test(key))
        .map(([, value]) => value ?? ''),
    ].filter(value => value.length > 0))]
  }
}

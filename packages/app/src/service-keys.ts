// Service keys: the "environment variables" screen.
//
// Everything the agent connects to beyond its brain — voice, repos, scrapers —
// is one vault entry, added from the phone. Two things stand between a tap and
// a stored value:
//
//  - shape. The operator taps a service, then sends "напомни про встречу" —
//    that message must not become their Deepgram key. A key is printable ASCII
//    without spaces, and several vendors prefix theirs.
//  - a single GET, where the vendor has a one-line auth check. A rejected key
//    is refused outright; an unreachable vendor is stored with an honest note,
//    because the agent's host can be behind a filter and refusing there would
//    lock the operator out of their own key.

export interface ServiceKeyDefinition {
  id: string
  label: string
  envKey: string
  /** What the agent gains, in one line. */
  purpose: string
  /** Where the operator gets it. */
  source: string
  /** Stable vendor prefix, where the vendor actually commits to one. */
  prefix?: string
  /** A GET that answers 200 for a good key and 401/403 for a bad one. */
  verify?: { url: string; header: (key: string) => Record<string, string> }
}

export const SERVICE_KEY_CATALOG: readonly ServiceKeyDefinition[] = Object.freeze([
  {
    id: 'deepgram',
    label: '🎙 Deepgram',
    // The transcription provider asks its resolver for `DEEPGRAM_API_KEY`; the
    // vault keeps Aisy's own naming and the resolver maps between them.
    envKey: 'AISY_DEEPGRAM_KEY',
    purpose: 'расшифровка голосовых и аудио',
    source: 'console.deepgram.com → API Keys (при регистрации дают стартовый баланс)',
    verify: {
      url: 'https://api.deepgram.com/v1/projects',
      header: (key) => ({ Authorization: `Token ${key}` }),
    },
  },
  {
    id: 'github',
    label: '🐙 GitHub',
    envKey: 'AISY_GITHUB_TOKEN',
    purpose: 'репозитории, коммиты, задачи',
    source: 'github.com/settings/tokens → fine-grained, только нужные репозитории',
    prefix: 'gh',
    verify: {
      url: 'https://api.github.com/user',
      header: (key) => ({ Authorization: `Bearer ${key}`, 'User-Agent': 'aisy-agent' }),
    },
  },
  {
    id: 'openrouter',
    label: '🔀 OpenRouter',
    envKey: 'AISY_PROVIDER_OPENROUTER_KEY',
    purpose: 'второй мозг и эмбеддинги для поиска по смыслу',
    source: 'openrouter.ai → Keys',
    prefix: 'sk-or-',
    verify: {
      url: 'https://openrouter.ai/api/v1/key',
      header: (key) => ({ Authorization: `Bearer ${key}` }),
    },
  },
  {
    id: 'serper',
    label: '🔎 Serper',
    envKey: 'AISY_SERPER_KEY',
    purpose: 'нормальный поиск в интернете вместо бесплатного',
    source: 'serper.dev → API Key',
  },
  {
    id: 'supadata',
    label: '📹 Supadata',
    envKey: 'AISY_SUPADATA_KEY',
    purpose: 'транскрипты видео из YouTube, TikTok, Instagram',
    source: 'supadata.ai → Dashboard → API Key',
  },
  {
    id: 'apify',
    label: '🕷 Apify',
    envKey: 'AISY_APIFY_TOKEN',
    purpose: 'скрейперы для площадок, которые не отдают данные напрямую',
    source: 'console.apify.com → Settings → Integrations → API token',
    prefix: 'apify_api_',
    verify: {
      url: 'https://api.apify.com/v2/users/me',
      header: (key) => ({ Authorization: `Bearer ${key}` }),
    },
  },
])

/**
 * Keys the runtime owns. Overwriting one from a chat message would hand the bot
 * a token nothing validated and could lock the operator out of their own agent.
 */
const PROTECTED_KEYS = new Set([
  'AISY_TELEGRAM_BOT_TOKEN',
  'AISY_TELEGRAM_CHAT_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
])

const CUSTOM_KEY = /^[A-Z][A-Z0-9_]{2,63}$/

/**
 * A credential is printable ASCII with no whitespace. This is what separates a
 * key from a sentence: any Cyrillic, space or newline means the operator was
 * talking to the agent, not answering the prompt.
 */
const KEY_SHAPE = /^[\x21-\x7E]{16,512}$/

export type ServiceKeyErrorCode =
  | 'VALUE_EMPTY'
  | 'UNKNOWN_SERVICE'
  | 'PROTECTED_KEY'
  | 'INVALID_KEY_NAME'
  | 'NOT_A_KEY'
  | 'WRONG_PREFIX'
  | 'KEY_REJECTED'
  | 'VAULT_CORRUPT'
  | 'PERSISTENCE_FAILED'

export type ServiceKeyResult =
  | { ok: true; envKey: string; verified: boolean }
  | { ok: false; errorCode: ServiceKeyErrorCode }

export interface ServiceKeyStore {
  /** Names of catalogue services that already have a value. */
  connected(): readonly string[]
  store(serviceId: string, value: string): Promise<ServiceKeyResult>
  /** `NAME=value` for a service outside the catalogue. */
  storeCustom(line: string): ServiceKeyResult
}

export interface ServiceKeyStoreDeps {
  vaultPath: string
  exists(path: string): boolean
  readFile(path: string): string
  writePrivateFile(path: string, content: string): void
  renameFile(from: string, to: string): void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function findServiceKey(serviceId: string): ServiceKeyDefinition | undefined {
  return SERVICE_KEY_CATALOG.find((entry) => entry.id === serviceId)
}

export function makeServiceKeyStore(deps: ServiceKeyStoreDeps): ServiceKeyStore {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 8_000

  /**
   * `null` means the vendor could not be reached — not that the key is bad. A
   * blocked region or an offline host must not cost the operator a valid key.
   */
  const probe = async (
    entry: ServiceKeyDefinition,
    key: string,
  ): Promise<boolean | null> => {
    if (!entry.verify) return null
    try {
      const response = await fetchImpl(entry.verify.url, {
        headers: entry.verify.header(key),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 401 || response.status === 403) return false
      return response.status >= 200 && response.status < 400 ? true : null
    } catch {
      return null
    }
  }

  const load = (): Record<string, unknown> | null =>
    deps.exists(deps.vaultPath) ? parseObject(deps.readFile(deps.vaultPath)) : {}

  const write = (envKey: string, value: string, verified: boolean): ServiceKeyResult => {
    if (PROTECTED_KEYS.has(envKey)) return { ok: false, errorCode: 'PROTECTED_KEY' }
    const vault = load()
    if (vault === null) return { ok: false, errorCode: 'VAULT_CORRUPT' }
    try {
      const temp = deps.vaultPath + '.tmp'
      deps.writePrivateFile(temp, JSON.stringify({ ...vault, [envKey]: value }, null, 2) + '\n')
      deps.renameFile(temp, deps.vaultPath)
    } catch {
      return { ok: false, errorCode: 'PERSISTENCE_FAILED' }
    }
    return { ok: true, envKey, verified }
  }

  return Object.freeze<ServiceKeyStore>({
    connected() {
      const vault = load()
      if (vault === null) return []
      return SERVICE_KEY_CATALOG
        .filter((entry) => typeof vault[entry.envKey] === 'string' && vault[entry.envKey] !== '')
        .map((entry) => entry.id)
    },

    async store(serviceId, rawValue) {
      const value = rawValue.trim()
      if (value.length === 0) return { ok: false, errorCode: 'VALUE_EMPTY' }
      const entry = findServiceKey(serviceId)
      if (!entry) return { ok: false, errorCode: 'UNKNOWN_SERVICE' }
      if (!KEY_SHAPE.test(value)) return { ok: false, errorCode: 'NOT_A_KEY' }
      if (entry.prefix !== undefined && !value.startsWith(entry.prefix)) {
        return { ok: false, errorCode: 'WRONG_PREFIX' }
      }
      // Read the vault before going to the network: if the write cannot succeed
      // there is no reason to send the operator's key anywhere.
      if (load() === null) return { ok: false, errorCode: 'VAULT_CORRUPT' }
      const verdict = await probe(entry, value)
      if (verdict === false) return { ok: false, errorCode: 'KEY_REJECTED' }
      return write(entry.envKey, value, verdict === true)
    },

    storeCustom(line) {
      const separator = line.indexOf('=')
      if (separator <= 0) return { ok: false, errorCode: 'INVALID_KEY_NAME' }
      const name = line.slice(0, separator).trim()
      const value = line.slice(separator + 1).trim()
      if (value.length === 0) return { ok: false, errorCode: 'VALUE_EMPTY' }
      if (!CUSTOM_KEY.test(name)) return { ok: false, errorCode: 'INVALID_KEY_NAME' }
      // No catalogue entry means no vendor to ask — shape is all we have.
      if (!KEY_SHAPE.test(value)) return { ok: false, errorCode: 'NOT_A_KEY' }
      return write(name, value, false)
    },
  })
}

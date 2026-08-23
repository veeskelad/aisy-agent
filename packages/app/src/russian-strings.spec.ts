// Страж русского текста в транспорте.
//
// Экраны рисует telegram-gw, и его выход проверяется своим тестом. Но половину
// того, что читает оператор, транспорт пишет сам: ответы команд, тексты ошибок,
// подсказки после тапа. Именно там жил жаргон, на который пожаловался оператор:
// «Сейчас идёт turn», «Poll остановится, exact-domain grant будет отозван»,
// «Сообщение удалю best-effort перед confined read и step-up».
//
// Рендерер здесь не поднять — строки разбросаны по обработчикам, — поэтому
// проверяется исходник: строковый литерал, в котором есть кириллица, считается
// операторским текстом, и английские слова в нём запрещены.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Латиница, которая остаётся: имена собственные, форматы и то, что оператор сам
 * вводит. Список закрытый: новое слово либо имя сервиса и добавляется сюда
 * осознанно, либо жаргон из кода — и тогда тест обязан упасть.
 */
const ALLOWED = new Set([
  'aisy', 'telegram', 'mcp', 'ssh', 'rss', 'https', 'http', 'url', 'utc', 'api',
  'deepgram', 'claude', 'codex', 'chatgpt', 'openai', 'openrouter', 'anthropic',
  'github', 'serper', 'supadata', 'apify', 'whisper', 'nova', 'code', 'pre', 'b',
  'i', 'u', 's', 'a', 'href', 'br', 'blockquote', 'json', 'yaml', 'csv', 'md',
  'txt', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'log', 'sk', 'ant', 'npm',
  'setup', 'token', 'g', 'ai', 'nl', 'n', 'x', 'id', 'bot',
  // Сервисы, которые называются только так.
  'youtube', 'tiktok', 'instagram', 'notion', 'railway', 'vercel', 'supabase',
  'keys', 'max', 'pro', 'nano', 'mini',
  // Поля формата SKILL.md — имена в самом файле, не наш текст.
  'name', 'description', 'version', 'provenance', 'triggers', 'verification',
])

/**
 * Файлы, чей текст читает оператор.
 *
 * `bin/aisy.ts` сюда не входит намеренно: там рядом живут строки для человека и
 * ответы инструментов, которые читает модель («fetch_url: ничего не найдено»).
 * Английское имя инструмента в ответе модели — это адрес, а не жаргон, и
 * запрещать его значило бы ломать протокол ради вида.
 */
function transportFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .filter((name) =>
      name === 'bot.ts' || name === 'setup-bot.ts' || name === 'execution-mode.ts' ||
      name === 'plan-tool-protocol.ts' || name === 'service-keys.ts' ||
      name === 'deep-research.ts' || name === 'goal-orchestrator.ts' ||
      name.startsWith('telegram-'))
    .map((name) => join(HERE, name))
}

/**
 * Строковые литералы с кириллицей — то есть написанные для человека.
 *
 * Грубый разбор вместо TypeScript AST намеренно: цена ошибки здесь — лишняя
 * строка в отчёте, а не пропущенный дефект, и такой разбор переживает любую
 * смену версии парсера.
 */
function operatorStrings(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`]*)`/g)) {
    // Экранированные переводы строк — часть литерала, а не слово: без этого
    // «...нет.\n\nMCP» читается как слово «nMCP».
    const text = (match[1] ?? match[2] ?? '').replace(/\\[nrt]/g, ' ')
    if (/[А-Яа-яЁё]/.test(text)) found.push(text)
  }
  return found
}

/** Английские слова в тексте, кроме допустимых. */
function foreignWords(text: string): string[] {
  const cleaned = text
    // Подстановки `${...}` — это код, а не слова интерфейса.
    .replace(/\$\{[^}]*\}/g, ' ')
    // HTML-теги, которыми транспорт размечает свои же сообщения.
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    // Адреса, пути и имена переменных окружения оператор вводит и читает сам.
    .replace(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, ' ')
    // Слэш-команда вместе со своими вариантами: «/mode auto | confirm | plan».
    .replace(/\/[a-z]+(?:[ \t]*\|?[ \t]*[a-z0-9.:@[\]]+)*/gi, ' ')
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, ' ')
    // Плейсхолдеры подсказок — <30m|2h|ISO>, <имя>, <chatId>.
    .replace(/<[^<>]*>/g, ' ')
    // Куски кода внутри текста: `npx`, `tracker /usr/bin/...`.
    .replace(/`[^`]*`/g, ' ')
    // Имена инструментов и команд: submit_plan, ssh-ed25519.
    .replace(/\b[a-z]+[_-][a-z0-9_-]+\b/gi, ' ')
  return [...cleaned.matchAll(/[A-Za-z]+/g)]
    .map((match) => match[0])
    .filter((word) => !ALLOWED.has(word.toLowerCase()))
}

describe('транспорт говорит по-русски', () => {
  const files = transportFiles()

  it('находит файлы транспорта', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files.map((file) => [file.slice(HERE.length + 1), file]))(
    'в %s нет английского в операторских строках',
    (_name, file) => {
      const offenders = operatorStrings(readFileSync(file, 'utf8'))
        .map((text) => ({ text, words: foreignWords(text) }))
        .filter((entry) => entry.words.length > 0)
        .map((entry) => `${entry.words.join(', ')} — «${entry.text.slice(0, 90)}»`)

      expect(offenders).toEqual([])
    },
  )
})

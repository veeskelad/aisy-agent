import { appendFileSync } from 'node:fs'

const path = process.env['AISY_EXTERNAL_FETCH_SENTINEL']
if (path === undefined || path === '') throw new Error('AISY_EXTERNAL_FETCH_SENTINEL is required')

globalThis.fetch = async (input) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  appendFileSync(path, `${Date.now()} fetch ${process.pid} ${target}\n`, { mode: 0o600 })
  throw new Error('fixture external I/O denied')
}

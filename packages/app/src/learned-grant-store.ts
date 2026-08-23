// Node-адаптер хранилища выученных грантов (спека 24 §5, ADR-0099).
//
// Семантика — в ядре (autonomy-promotion.ts): версии, TTL, одноразовый proof,
// отзыв. Здесь только байты и их выживание: атомарная запись через tmp+rename
// +fsync, права 0600, каталог 0700.
//
// Нечитаемое состояние наверх отдаётся как «нет состояния»: реестр отвечает на
// это fail-closed — новые гранты не выдаются, действующие не применяются, всё
// снова идёт через карточки. Файл при этом не трогается: разбирать, что с ним
// случилось, будет человек, а молча потерянные полномочия хуже отказа.

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import type { LearnedGrantPersistence, LearnedGrantStateV1 } from '@aisy/core'

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function makeNodeLearnedGrantStore(input: { path: string }): LearnedGrantPersistence {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  return {
    load() {
      if (!existsSync(input.path)) return null
      try {
        return JSON.parse(readFileSync(input.path, 'utf8')) as unknown
      } catch {
        // Не `null`: пустое состояние означало бы «грантов не было», и реестр
        // спокойно начал бы выдавать новые поверх нечитаемой истории.
        return { broken: true }
      }
    },

    save(state: LearnedGrantStateV1) {
      const tempPath = `${input.path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      syncPath(tempPath)
      renameSync(tempPath, input.path)
      syncPath(directory)
    },
  }
}

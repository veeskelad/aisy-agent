// Node-адаптер evidence store обучаемой автономности (спека 24). LIVE с
// ADR-0103: production composition держит его в `~/.aisy/autonomy/`.
//
// Формат — append-only JSONL в каталоге состояния владельца (0700). Семантика
// принадлежит ядру (autonomy-evidence.ts); здесь только байты и их выживание:
// атомарная перезапись через tmp+rename+fsync, как у остальных store, и
// карантин повреждённого файла вместо тихой потери — файл с доказательствами
// не удаляется никогда, даже сломанный.

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
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

import type { EvidencePersistence } from '@aisy/core'

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export interface NodeAutonomyEvidenceStore extends EvidencePersistence {
  /**
   * Убирает нечитаемый файл с дороги, сохранив его содержимое. Возвращает путь
   * карантина или null, когда убирать нечего. Вызывается оператором/доктором,
   * не автоматически: решение пожертвовать проекцией — человеческое.
   */
  quarantine(): string | null
}

export function makeNodeAutonomyEvidenceStore(input: { path: string }): NodeAutonomyEvidenceStore {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  return {
    load() {
      if (!existsSync(input.path)) return []
      return readFileSync(input.path, 'utf8').split('\n').filter((l) => l.length > 0)
    },

    append(line: string) {
      appendFileSync(input.path, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      syncPath(input.path)
    },

    rewrite(lines: readonly string[]) {
      const tempPath = `${input.path}.tmp-${process.pid}-${randomUUID()}`
      const content = lines.length === 0 ? '' : `${lines.join('\n')}\n`
      writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(tempPath)
      renameSync(tempPath, input.path)
      syncPath(directory)
    },

    quarantine() {
      if (!existsSync(input.path)) return null
      const target = `${input.path}.corrupt-${Date.now()}`
      renameSync(input.path, target)
      syncPath(directory)
      return target
    },
  }
}

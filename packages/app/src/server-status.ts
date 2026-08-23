// Server state for the operator panel (plan 11.9).
//
// Everything here is read-only and cheap: the panel must answer "is it alive and
// does it have room" without touching the agent loop.

import { freemem, totalmem, uptime } from 'node:os'
import { statfsSync } from 'node:fs'

export interface ServerStatus {
  /** Process uptime in seconds — how long this run has been alive. */
  processUptimeSec: number
  /** Host uptime in seconds. */
  hostUptimeSec: number | null
  memory: { totalBytes: number; freeBytes: number; usedShare: number }
  /** Null when the filesystem cannot be measured; never a fabricated zero. */
  disk: { totalBytes: number; freeBytes: number; usedShare: number } | null
  version: string
  nodeVersion: string
}

function share(total: number, free: number): number {
  return total > 0 ? Math.min(1, Math.max(0, (total - free) / total)) : 0
}

export function readServerStatus(deps: {
  /** Directory whose filesystem is measured — normally the installation root. */
  root: string
  version: string
  processUptimeSec?: () => number
  hostUptimeSec?: () => number
}): ServerStatus {
  const total = totalmem()
  const free = freemem()

  let hostUptimeSec: number | null = null
  try {
    const measuredHostUptimeSec = deps.hostUptimeSec?.() ?? uptime()
    if (Number.isFinite(measuredHostUptimeSec)) {
      hostUptimeSec = Math.max(0, Math.round(measuredHostUptimeSec))
    }
  } catch {
    // Some restricted runtimes deny uv_uptime. Unavailable is more truthful
    // than either crashing the operator panel or fabricating a zero.
  }

  let disk: ServerStatus['disk'] = null
  try {
    const stats = statfsSync(deps.root)
    const totalBytes = Number(stats.blocks) * Number(stats.bsize)
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(freeBytes)) {
      disk = { totalBytes, freeBytes, usedShare: share(totalBytes, freeBytes) }
    }
  } catch {
    // An unmeasurable filesystem stays null: a fabricated zero would read as
    // "the disk is full" and trigger exactly the wrong reaction.
  }

  return {
    processUptimeSec: Math.max(0, Math.round(deps.processUptimeSec?.() ?? process.uptime())),
    hostUptimeSec,
    memory: { totalBytes: total, freeBytes: free, usedShare: share(total, free) },
    disk,
    version: deps.version,
    nodeVersion: process.version,
  }
}

function humanBytes(bytes: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function humanDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days} д ${hours} ч`
  if (hours > 0) return `${hours} ч ${minutes} мин`
  return `${minutes} мин`
}

export function renderServerStatus(status: ServerStatus): string {
  const percent = (value: number) => `${Math.round(value * 100)} %`
  const lines = [
    `Версия: ${status.version} · Node ${status.nodeVersion}`,
    `Процесс живёт: ${humanDuration(status.processUptimeSec)}`,
    status.hostUptimeSec === null
      ? 'Хост живёт: измерить не удалось'
      : `Хост живёт: ${humanDuration(status.hostUptimeSec)}`,
    `Память: ${percent(status.memory.usedShare)} занято, свободно ${humanBytes(status.memory.freeBytes)} из ${humanBytes(status.memory.totalBytes)}`,
    status.disk === null
      ? 'Диск: измерить не удалось'
      : `Диск: ${percent(status.disk.usedShare)} занято, свободно ${humanBytes(status.disk.freeBytes)} из ${humanBytes(status.disk.totalBytes)}`,
  ]
  return lines.join('\n')
}

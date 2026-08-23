/** ADR-0063 fixed global DNA order. Project/session material stays lazy. */
export const GLOBAL_DNA_PREFIX_FILES = Object.freeze([
  'constitution.md',
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  'MISSION.md',
  'GOALS.md',
  'PROJECTS.md',
  'PREFERENCES.md',
  'LEARNED.md',
  'CLAUDE.md',
  'SERVICES.md',
] as const)

export type GlobalDnaPrefixFile = typeof GLOBAL_DNA_PREFIX_FILES[number]

export const GLOBAL_DNA_MEMORY_PATHS: readonly `memory/${GlobalDnaPrefixFile}`[] =
  Object.freeze(GLOBAL_DNA_PREFIX_FILES.map(name => `memory/${name}` as const))

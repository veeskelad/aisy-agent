import type {
  ProjectRegistryPersistencePort,
  ProjectRegistryState,
} from '@aisy/core'

export interface JsonProjectRegistryStoreDeps {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, content: string): void
  renameFile(from: string, to: string): void
}

export function makeJsonProjectRegistryStore(
  deps: JsonProjectRegistryStoreDeps,
): ProjectRegistryPersistencePort {
  const tempPath = deps.path + '.tmp'

  return {
    load(): ProjectRegistryState | null {
      if (!deps.exists(deps.path)) return null
      return JSON.parse(deps.readFile(deps.path)) as ProjectRegistryState
    },

    save(state: ProjectRegistryState): void {
      deps.writeFile(tempPath, JSON.stringify(state, null, 2) + '\n')
      deps.renameFile(tempPath, deps.path)
    },
  }
}

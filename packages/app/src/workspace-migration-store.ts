import { dirname } from 'node:path'
import {
  resolveWorkspaceRegistryStartupMode,
  validateWorkspaceMigrationManifest,
  type WorkspaceMigrationManifest,
  type WorkspaceMigrationManifestPersistencePort,
  type WorkspaceRegistryStartupMode,
} from '@aisy/core'

export interface WorkspaceMigrationManifestReaderDeps {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
}

export function readWorkspaceRegistryStartupMode(
  deps: WorkspaceMigrationManifestReaderDeps,
): WorkspaceRegistryStartupMode {
  if (!deps.exists(deps.path)) return 'v1-live'
  const manifest = validateWorkspaceMigrationManifest(
    JSON.parse(deps.readFile(deps.path)) as WorkspaceMigrationManifest,
  )
  return resolveWorkspaceRegistryStartupMode(manifest)
}

export interface JsonWorkspaceMigrationManifestStoreDeps {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, content: string): void
  syncFile(path: string): void
  renameFile(from: string, to: string): void
  syncDirectory(path: string): void
}

/**
 * Durable manifest publication boundary. Callers must provide real fsync
 * adapters in production; a successful return means both file contents and
 * the directory rename have crossed their persistence boundaries.
 */
export function makeJsonWorkspaceMigrationManifestStore(
  deps: JsonWorkspaceMigrationManifestStoreDeps,
): WorkspaceMigrationManifestPersistencePort {
  const tempPath = deps.path + '.tmp'
  return {
    load(): WorkspaceMigrationManifest {
      if (!deps.exists(deps.path)) {
        throw new Error('WORKSPACE_MIGRATION_MANIFEST_NOT_FOUND')
      }
      return validateWorkspaceMigrationManifest(
        JSON.parse(deps.readFile(deps.path)) as WorkspaceMigrationManifest,
      )
    },

    saveAtomic(input: WorkspaceMigrationManifest): void {
      const manifest = validateWorkspaceMigrationManifest(input)
      deps.writeFile(tempPath, JSON.stringify(manifest, null, 2) + '\n')
      deps.syncFile(tempPath)
      deps.renameFile(tempPath, deps.path)
      deps.syncDirectory(dirname(deps.path))
    },
  }
}

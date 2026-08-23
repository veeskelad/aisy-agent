// Fixed observability boundaries for the restart receipt protocol. Production
// deliberately performs no action here; tests replace this internal module to
// inject failures without adding an injectable filesystem or publisher API.

export type RestartCheckpoint =
  | 'publish:after-open-before-stat'
  | 'publish:before-file-fsync'
  | 'publish:after-file-fsync'
  | 'publish:before-rename'
  | 'publish:after-rename'
  | 'publish:before-dir-fsync'
  | 'publish:after-dir-fsync'
  | 'publish:before-rollback-unlink'
  | 'publish:before-rollback-dir-fsync'
  | 'cancel:before-unlink'
  | 'cancel:before-dir-fsync'
  | 'consume:before-rename'
  | 'consume:after-rename'
  | 'consume:before-dir-fsync'
  | 'consume:after-dir-fsync'
  | 'consume:before-rollback-rename'
  | 'consume:before-rollback-dir-fsync'

export function restartCheckpoint(_point: RestartCheckpoint): void {
  // Intentionally empty in production.
}

// Public two-phase restart API. Fault checkpoints and filesystem internals stay
// in runtime-restart-internal and are not exported from this production module.

import {
  makeRuntimeRestartInternal,
  type RestartIntent,
  type RuntimeRestart,
  type RuntimeRestartDeps,
} from './runtime-restart-internal.js'

export type {
  RestartCommitResult,
  RestartCancelResult,
  RestartIntent,
  RestartRefusal,
  RuntimeRestart,
  RuntimeRestartDeps,
} from './runtime-restart-internal.js'

export function makeRuntimeRestart(deps: RuntimeRestartDeps): RuntimeRestart {
  return makeRuntimeRestartInternal(deps)
}

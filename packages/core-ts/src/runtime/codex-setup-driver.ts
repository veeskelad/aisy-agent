import type { BrainConnectionSetupDriver } from '../onboarding/brain-bootstrap-coordinator.js'
import type { BrainInstallResult } from '../onboarding/brain-connections.js'
import type { CodexSubscriptionAuth } from './codex-auth.js'

/**
 * Adapts the official Codex subscription login lifecycle to deterministic
 * bootstrap orchestration. Runtime installation remains an explicit injected
 * port so this adapter never invents or silently executes an installer.
 */
export function makeCodexSubscriptionSetupDriver(input: {
  auth: CodexSubscriptionAuth
  install(): Promise<BrainInstallResult>
}): BrainConnectionSetupDriver {
  return Object.freeze({
    connectionId: 'codex-subscription',
    provider: 'openai',
    authMode: 'subscription',
    runtime: 'codex-app-server',
    detect: () => input.auth.detect(),
    install: () => input.install(),
    beginAuth: () => input.auth.beginAuth(),
    validate: () => input.auth.validate(),
    revoke: () => input.auth.revoke(),
  })
}

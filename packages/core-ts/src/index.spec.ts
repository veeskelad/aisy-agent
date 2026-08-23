import { describe, it, expect } from 'vitest'
import * as core from './index.js'

describe('@aisy/core barrel — delegation surface', () => {
  it('re-exports makeDelegationManager and the scope errors', () => {
    expect(typeof core.makeDelegationManager).toBe('function')
    expect(typeof core.ScopeConflictError).toBe('function')
    expect(typeof core.ScopeViolationError).toBe('function')
  })
})

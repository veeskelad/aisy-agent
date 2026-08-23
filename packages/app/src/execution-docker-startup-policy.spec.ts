import { describe, expect, it } from 'vitest'

import {
  executionDockerStartupRefusal,
  OWNED_DOCKER_PARENT_BROKER_REQUIRED,
  withoutChildOwnedDockerEnv,
} from './execution-docker-startup-policy.js'

describe('execution Docker startup policy', () => {
  it.each([
    { AISY_SANDBOX_IMAGE: 'registry.example/aisy/bash:latest' },
    { AISY_WHISPER_IMAGE: `registry.example/aisy/whisper@sha256:${'a'.repeat(64)}` },
    { AISY_RESTRICTED_CLONE_ENABLED: '1' },
    { AISY_RESTRICTED_CLONE_ENABLED: 'true' },
    { AISY_RESTRICTED_CLONE_ENABLED: 'yes' },
    { AISY_RESTRICTED_CLONE_ENABLED: 'invalid' },
  ])('refuses legacy child-owned activation without inspecting its value', (env) => {
    expect(executionDockerStartupRefusal(env)).toBe(OWNED_DOCKER_PARENT_BROKER_REQUIRED)
  })

  it.each([
    {},
    { AISY_SANDBOX_IMAGE: '', AISY_WHISPER_IMAGE: '' },
    { AISY_RESTRICTED_CLONE_ENABLED: '' },
    { AISY_RESTRICTED_CLONE_ENABLED: '0' },
    { AISY_RESTRICTED_CLONE_ENABLED: 'false' },
    { AISY_RESTRICTED_CLONE_ENABLED: 'no' },
    { AISY_DOCKER: '/usr/bin/docker', AISY_SANDBOX_GVISOR: '1' },
  ])('keeps disabled and inert configuration non-blocking', (env) => {
    expect(executionDockerStartupRefusal(env)).toBeNull()
  })

  it('removes every child-owned Docker knob without changing unrelated input', () => {
    expect(withoutChildOwnedDockerEnv({
      AISY_DOCKER: '/usr/bin/docker',
      AISY_RESTRICTED_CLONE_ENABLED: 'true',
      AISY_RESTRICTED_CLONE_GATEWAY_IMAGE: 'gateway',
      AISY_RESTRICTED_CLONE_WORKER_IMAGE: 'worker',
      AISY_SANDBOX_GVISOR: '1',
      AISY_SANDBOX_IMAGE: 'bash',
      AISY_WHISPER_IMAGE: 'whisper',
      AISY_OWNED_DOCKER_RECOVERY: '1',
      AISY_OWNED_DOCKER_SOCKET: '/run/docker.sock',
      AISY_OWNED_DOCKER_INSTALLATION_ID: 'a'.repeat(64),
      AISY_OWNED_DOCKER_SERVER_ID: 'daemon-one',
      AISY_OWNED_DOCKER_SERVER_VERSION: '29.5.2',
      DOCKER_CONFIG: '/private/docker-config',
      DOCKER_CONTEXT: 'private-context',
      DOCKER_HOST: 'unix:///private/docker.sock',
      AISY_HOME: '/private/aisy',
      PATH: '/usr/bin',
    })).toEqual({ AISY_HOME: '/private/aisy', PATH: '/usr/bin' })
  })

  it('ignores inherited activation and never invokes accessors', () => {
    let reads = 0
    const source = Object.create({ AISY_SANDBOX_IMAGE: 'inherited-image' }) as Record<string, unknown>
    Object.defineProperty(source, 'AISY_WHISPER_IMAGE', {
      enumerable: true,
      get() { reads += 1; return 'accessor-image' },
    })

    expect(executionDockerStartupRefusal(Object.create({
      AISY_SANDBOX_IMAGE: 'inherited-image',
    }))).toBeNull()
    expect(executionDockerStartupRefusal(source)).toBe(OWNED_DOCKER_PARENT_BROKER_REQUIRED)
    expect(withoutChildOwnedDockerEnv(source)).toEqual({})
    expect(reads).toBe(0)
  })

  it('normalizes malformed inputs to deterministic fail-closed results', () => {
    const throwing = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error('must not escape') },
    })

    for (const value of [null, [], 'invalid', throwing]) {
      expect(executionDockerStartupRefusal(value)).toBe(OWNED_DOCKER_PARENT_BROKER_REQUIRED)
    }
    expect(withoutChildOwnedDockerEnv(throwing)).toEqual({})
  })
})

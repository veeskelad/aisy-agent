import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isRestrictedCloneDockerVersionCompatible,
  type RestrictedCloneTarget,
} from '@aisy/core'
import {
  makeNodeDockerCommandPort,
  makeRestrictedCloneDockerSupervisor,
  RestrictedCloneDockerSupervisorError,
  type DockerCommandPort,
} from './restricted-clone-docker-supervisor.js'
import {
  makeRestrictedCloneSidecarTransport,
  type RestrictedCloneSidecarAttestation,
  type RestrictedCloneSidecarRequest,
} from './restricted-clone-sidecar.js'

const mode = (import.meta as ImportMeta & {
  readonly env?: Readonly<{ MODE?: string }>
}).env?.MODE
const enabled = mode === 'restricted-clone-smoke'
const dockerExecutable = process.env['AISY_TEST_DOCKER_EXECUTABLE'] ?? '/usr/local/bin/docker'
const desktopDockerSocket = join(homedir(), '.docker', 'run', 'docker.sock')
const dockerHost = process.platform === 'darwin' && existsSync(desktopDockerSocket)
  ? `unix://${desktopDockerSocket}`
  : undefined
const projectsRoot = '/srv/aisy/projects'
const stagingRoot = `${projectsRoot}/.aisy-staging-docker-real-1`
const workerImage = `registry.example/aisy/clone@sha256:${'a'.repeat(64)}`
const gatewayImage = `registry.example/aisy/egress@sha256:${'b'.repeat(64)}`

function target(): RestrictedCloneTarget {
  return {
    url: 'https://git.example.org/team/repo.git',
    hostname: 'git.example.org',
    port: 443,
    addresses: [{ address: '93.184.216.34', family: 4 }],
    transportPolicy: {
      connectOnlyToReviewedAddresses: true,
      preserveTlsServerName: true,
      followRedirects: false,
    },
  }
}

function attestation(request: RestrictedCloneSidecarRequest): RestrictedCloneSidecarAttestation {
  return {
    protocolVersion: 1,
    executionId: request.executionId,
    policyHash: request.policyHash,
    imageDigest: request.imageDigest,
    stagingIdentity: request.staging.identity,
    outcome: 'succeeded',
    exitCode: 0,
    outputBytes: 0,
    sandboxDestroyed: true,
    applied: {
      network: 'isolated-egress-gateway-only',
      credentials: 'none',
      hostNetwork: false,
      dockerSocket: false,
      privileged: false,
    },
  }
}

async function requestFixture(): Promise<RestrictedCloneSidecarRequest> {
  let captured: RestrictedCloneSidecarRequest | undefined
  const transport = makeRestrictedCloneSidecarTransport({
    projectsRoot,
    imageDigest: workerImage,
    supervisor: {
      async run(request) {
        captured = request
        return attestation(request)
      },
    },
    newId: () => 'clone-docker-real-1',
    inspectStaging: path => ({ canonicalRoot: path, identity: 'device-1:inode-2' }),
  })
  await transport.clone({ target: target(), stagingRoot })
  if (captured === undefined) throw new Error('request not captured')
  return captured
}

describe.skipIf(!enabled || !existsSync(dockerExecutable))(
  'Restricted clone incompatible Docker read-only integration',
  () => {
    it('rejects the real daemon version before requesting any resource mutation', async () => {
      const request = await requestFixture()
      const realDocker = makeNodeDockerCommandPort({
        dockerExecutable,
        ...(dockerHost === undefined ? {} : { dockerHost }),
      })
      const calls: string[][] = []
      let observedVersion: string | undefined
      const guardedDocker: DockerCommandPort = {
        async run(args, options) {
          calls.push([...args])
          if (args.length !== 2 || args[0] !== 'version' ||
            args[1] !== '--format={{.Server.Version}}') {
            throw new Error('MUTATING_DOCKER_COMMAND_DENIED')
          }
          const result = await realDocker.run(args, options)
          observedVersion = result.stdout.trim()
          return result
        },
      }
      const supervisor = makeRestrictedCloneDockerSupervisor({
        docker: guardedDocker,
        gatewayImageDigest: gatewayImage,
        listStaging: () => [],
      })

      await expect(supervisor.run(request)).rejects.toEqual(
        new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_RUNTIME_INCOMPATIBLE'),
      )
      expect(calls).toEqual([['version', '--format={{.Server.Version}}']])
      expect(observedVersion).toBeTruthy()
      expect(isRestrictedCloneDockerVersionCompatible(observedVersion ?? '')).toBe(false)
    }, 20_000)
  },
)

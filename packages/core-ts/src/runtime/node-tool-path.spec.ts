import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'

import { withNodeBinOnPath } from './node-tool-path.js'

const NODE = '/home/iam/.nvm/versions/node/v22.23.1/bin/node'
const NODE_BIN = '/home/iam/.nvm/versions/node/v22.23.1/bin'
const SYSTEMD_PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)

describe('withNodeBinOnPath', () => {
  it('puts the running Node directory first, so a `#!/usr/bin/env node` shebang resolves', () => {
    const env = withNodeBinOnPath({ PATH: SYSTEMD_PATH, HOME: '/home/iam' }, NODE)

    expect(env['PATH']?.split(delimiter)[0]).toBe(NODE_BIN)
    expect(env['PATH']).toBe([NODE_BIN, SYSTEMD_PATH].join(delimiter))
    expect(env['HOME']).toBe('/home/iam')
  })

  it('works when the service manager passed no PATH at all', () => {
    expect(withNodeBinOnPath({}, NODE)['PATH']).toBe(NODE_BIN)
  })

  it('never duplicates the entry', () => {
    const once = withNodeBinOnPath({ PATH: SYSTEMD_PATH }, NODE)
    const twice = withNodeBinOnPath(once, NODE)

    expect(twice['PATH']).toBe(once['PATH'])
  })

  it('moves an existing entry to the front instead of adding a second one', () => {
    const env = withNodeBinOnPath({ PATH: [SYSTEMD_PATH, NODE_BIN].join(delimiter) }, NODE)

    expect(env['PATH']).toBe([NODE_BIN, SYSTEMD_PATH].join(delimiter))
  })

  it('copies rather than mutates the caller’s environment', () => {
    const source = { PATH: SYSTEMD_PATH }
    withNodeBinOnPath(source, NODE)

    expect(source.PATH).toBe(SYSTEMD_PATH)
  })
})

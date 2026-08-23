import { describe, it, expect } from 'vitest'
import { systemdUnit, launchdPlist } from './service-files.js'

const opts = {
  execPath: '/usr/bin/node',
  binPath: '/usr/local/bin/aisy',
  home: '/home/user/.aisy',
  logPath: '/home/user/.aisy/run.log',
}

describe('systemdUnit', () => {
  it('contains Restart=always', () => {
    expect(systemdUnit(opts)).toContain('Restart=always')
  })

  it('contains correct ExecStart line', () => {
    expect(systemdUnit(opts)).toContain(`ExecStart="${opts.execPath}" "${opts.binPath}" supervise`)
  })

  it('contains required service fields', () => {
    const unit = systemdUnit(opts)
    const required = [
      ['RestartSec', '5'],
      ['KillMode', 'control-group'],
      ['KillSignal', 'SIGTERM'],
      ['SendSIGKILL', 'yes'],
      ['FinalKillSignal', 'SIGKILL'],
      ['TimeoutStopSec', '15'],
      ['UMask', '0077'],
    ]
    for (const pair of required) {
      expect(unit).toContain(pair.join('='))
    }
    expect(unit).not.toContain('AISY_' + 'SUPERVISED')
  })

  it('contains AISY_HOME environment variable', () => {
    expect(systemdUnit(opts)).toContain(`Environment="AISY_HOME=${opts.home}"`)
  })

  it('contains StandardOutput and StandardError append directives pointing at logPath', () => {
    const unit = systemdUnit(opts)
    expect(unit).toContain(`StandardOutput="append:${opts.logPath}"`)
    expect(unit).toContain(`StandardError="append:${opts.logPath}"`)
  })

  it('contains [Unit], [Service], [Install] sections', () => {
    const unit = systemdUnit(opts)
    expect(unit).toContain('[Unit]')
    expect(unit).toContain('[Service]')
    expect(unit).toContain('[Install]')
  })

  it('contains After=network-online.target', () => {
    expect(systemdUnit(opts)).toContain('After=network-online.target')
  })

  it('contains WantedBy=default.target', () => {
    expect(systemdUnit(opts)).toContain('WantedBy=default.target')
  })

  it('quotes special path tokens and refuses line injection', () => {
    const dollar = String.fromCharCode(36)
    const unit = systemdUnit({
      execPath: `/opt/Aisy ${dollar}node/%n/"quoted"/node\\x`,
      binPath: `/opt/Aisy tools/aisy;${dollar}bin`,
      home: `/home/a ${dollar}user/%n/aisy\\state`,
      logPath: `/home/a ${dollar}user/%n/log file`,
    })
    expect(unit).toContain(`${dollar}${dollar}node/%%n/\\"quoted\\"/node\\\\x`)
    expect(unit).toContain(`"/opt/Aisy tools/aisy;${dollar}${dollar}bin" supervise`)
    expect(unit).toContain(`Environment="AISY_HOME=/home/a ${dollar}user/%%n/aisy\\\\state"`)
    expect(() => systemdUnit({ ...opts, binPath: '/bin/aisy\nInjected=yes' })).toThrow(/control/)
  })
})

describe('launchdPlist', () => {
  it('is well-formed XML — starts with <?xml', () => {
    expect(launchdPlist(opts)).toMatch(/^<\?xml/)
  })

  it('contains KeepAlive true', () => {
    expect(launchdPlist(opts)).toContain('<key>KeepAlive</key>')
    expect(launchdPlist(opts)).toContain('<true/>')
  })

  it('contains a five-second throttle and no child supervision marker', () => {
    const plist = launchdPlist(opts)
    expect(plist).toContain('<key>ThrottleInterval</key>')
    expect(plist).toContain('<integer>5</integer>')
    expect(plist).toContain('<key>AbandonProcessGroup</key>')
    expect(plist).toContain('<false/>')
    expect(plist).toContain('<key>ExitTimeOut</key>')
    expect(plist).toContain('<integer>15</integer>')
    expect(plist).not.toContain('AISY_' + 'SUPERVISED')
  })

  it('contains RunAtLoad', () => {
    expect(launchdPlist(opts)).toContain('<key>RunAtLoad</key>')
  })

  it('contains Label com.aisy.agent', () => {
    const plist = launchdPlist(opts)
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain('<string>com.aisy.agent</string>')
  })

  it('contains ProgramArguments with execPath, binPath, and supervise', () => {
    const plist = launchdPlist(opts)
    expect(plist).toContain('<key>ProgramArguments</key>')
    expect(plist).toContain(`<string>${opts.execPath}</string>`)
    expect(plist).toContain(`<string>${opts.binPath}</string>`)
    expect(plist).toContain('<string>supervise</string>')
  })

  it('contains AISY_HOME in EnvironmentVariables', () => {
    const plist = launchdPlist(opts)
    expect(plist).toContain('<key>AISY_HOME</key>')
    expect(plist).toContain(`<string>${opts.home}</string>`)
  })

  it('contains StandardOutPath and StandardErrorPath pointing at logPath', () => {
    const plist = launchdPlist(opts)
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain('<key>StandardErrorPath</key>')
    expect(plist).toContain(`<string>${opts.logPath}</string>`)
  })

  it('escapes dynamic XML text and refuses line injection', () => {
    const plist = launchdPlist({
      execPath: '/opt/<node>&"\'bin',
      binPath: '/opt/aisy<&>"\'',
      home: '/Users/a<&>"\'/.aisy',
      logPath: '/Users/a<&>"\'/run.log',
    })
    expect(plist).toContain('/opt/&lt;node&gt;&amp;&quot;&apos;bin')
    expect(plist).toContain('/opt/aisy&lt;&amp;&gt;&quot;&apos;')
    expect(plist).toContain('/Users/a&lt;&amp;&gt;&quot;&apos;/.aisy')
    expect(() => launchdPlist({ ...opts, home: '/Users/a\rInjected' })).toThrow(/control/)
  })

  it.each(['\u0001', '\u000b', '\u000c', '\u001f', '\ud800', '\ufffe', '\uffff'])(
    'refuses an XML 1.0 forbidden character',
    (forbidden) => {
      expect(() => launchdPlist({ ...opts, binPath: `/bin/aisy${forbidden}` })).toThrow(/XML 1\.0/)
    },
  )

  it('preserves valid XML 1.0 tab and supplementary characters', () => {
    expect(launchdPlist({ ...opts, binPath: '/bin/aisy\t😀' })).toContain('/bin/aisy\t😀')
  })
})

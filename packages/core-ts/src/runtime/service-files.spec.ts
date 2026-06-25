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
    expect(systemdUnit(opts)).toContain(`ExecStart=${opts.execPath} ${opts.binPath} run`)
  })

  it('contains AISY_HOME environment variable', () => {
    expect(systemdUnit(opts)).toContain(`Environment=AISY_HOME=${opts.home}`)
  })

  it('contains StandardOutput and StandardError append directives pointing at logPath', () => {
    const unit = systemdUnit(opts)
    expect(unit).toContain(`StandardOutput=append:${opts.logPath}`)
    expect(unit).toContain(`StandardError=append:${opts.logPath}`)
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
})

describe('launchdPlist', () => {
  it('is well-formed XML — starts with <?xml', () => {
    expect(launchdPlist(opts)).toMatch(/^<\?xml/)
  })

  it('contains KeepAlive true', () => {
    expect(launchdPlist(opts)).toContain('<key>KeepAlive</key>')
    expect(launchdPlist(opts)).toContain('<true/>')
  })

  it('contains RunAtLoad', () => {
    expect(launchdPlist(opts)).toContain('<key>RunAtLoad</key>')
  })

  it('contains Label com.aisy.agent', () => {
    const plist = launchdPlist(opts)
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain('<string>com.aisy.agent</string>')
  })

  it('contains ProgramArguments with execPath, binPath, and run', () => {
    const plist = launchdPlist(opts)
    expect(plist).toContain('<key>ProgramArguments</key>')
    expect(plist).toContain(`<string>${opts.execPath}</string>`)
    expect(plist).toContain(`<string>${opts.binPath}</string>`)
    expect(plist).toContain('<string>run</string>')
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
})

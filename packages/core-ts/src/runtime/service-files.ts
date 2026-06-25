// Pure service-file generators — no I/O, fully testable.
// Used by the `service` adapter in onboarding-node.ts to write the
// OS-level unit/plist that keeps `aisy run` alive after terminal close
// and across reboots.

export interface ServiceOpts {
  execPath: string
  binPath: string
  home: string
  logPath: string
}

/**
 * Returns the text of a systemd user unit for `aisy run`.
 * The unit is suitable for `~/.config/systemd/user/aisy.service`.
 */
export function systemdUnit(opts: ServiceOpts): string {
  const { execPath, binPath, home, logPath } = opts
  return `[Unit]
Description=Aisy agent
After=network-online.target
[Service]
Type=simple
ExecStart=${execPath} ${binPath} run
Restart=always
RestartSec=5
Environment=AISY_HOME=${home}
StandardOutput=append:${logPath}
StandardError=append:${logPath}
[Install]
WantedBy=default.target
`
}

/**
 * Returns the text of a launchd agent plist for `aisy run`.
 * The plist is suitable for `~/Library/LaunchAgents/com.aisy.agent.plist`.
 */
export function launchdPlist(opts: ServiceOpts): string {
  const { execPath, binPath, home, logPath } = opts
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.aisy.agent</string>
	<key>ProgramArguments</key>
	<array>
		<string>${execPath}</string>
		<string>${binPath}</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>AISY_HOME</key>
		<string>${home}</string>
	</dict>
	<key>StandardOutPath</key>
	<string>${logPath}</string>
	<key>StandardErrorPath</key>
	<string>${logPath}</string>
</dict>
</plist>
`
}

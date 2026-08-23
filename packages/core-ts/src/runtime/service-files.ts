// Pure service-file generators — no I/O, fully testable.
// Used by the `service` adapter in onboarding-node.ts to write the
// OS-level unit/plist that keeps the parent supervisor alive after terminal close
// and across reboots.

export interface ServiceOpts {
  execPath: string
  binPath: string
  home: string
  logPath: string
}

function rejectLineBreaks(value: string, field: string): void {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${field} contains a forbidden control character`)
  }
}

function rejectXml10ForbiddenCharacters(value: string): void {
  // XML 1.0 permits TAB/LF/CR, U+0020–D7FF, U+E000–FFFD and valid
  // supplementary scalar values. Line breaks are rejected separately because
  // these values occupy a single plist text node.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(value)) {
    throw new Error('launchd value contains a forbidden XML 1.0 character')
  }
}

/** Quote one systemd token. ExecStart additionally expands `$`, while all of
 * these directives expand `%` specifiers even inside quotes. */
function systemdQuote(value: string, expandEnvironment: boolean): string {
  rejectLineBreaks(value, 'systemd value')
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(expandEnvironment ? /\$/g : /$^/, '$$$$')
  return `"${escaped}"`
}

/** Returns a systemd user unit which launches the code-owned parent supervisor. */
export function systemdUnit(opts: ServiceOpts): string {
  const { execPath, binPath, home, logPath } = opts
  return `[Unit]
Description=Aisy agent
After=network-online.target
[Service]
Type=simple
ExecStart=${systemdQuote(execPath, true)} ${systemdQuote(binPath, true)} supervise
Restart=always
RestartSec=5
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
FinalKillSignal=SIGKILL
TimeoutStopSec=15
UMask=0077
Environment=${systemdQuote(`AISY_HOME=${home}`, false)}
StandardOutput=${systemdQuote(`append:${logPath}`, false)}
StandardError=${systemdQuote(`append:${logPath}`, false)}
[Install]
WantedBy=default.target
`
}

function xmlText(value: string): string {
  rejectLineBreaks(value, 'launchd value')
  rejectXml10ForbiddenCharacters(value)
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Returns a launchd agent plist which launches the parent supervisor. */
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
		<string>${xmlText(execPath)}</string>
		<string>${xmlText(binPath)}</string>
		<string>supervise</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>AbandonProcessGroup</key>
	<false/>
	<key>ExitTimeOut</key>
	<integer>15</integer>
	<key>EnvironmentVariables</key>
	<dict>
		<key>AISY_HOME</key>
		<string>${xmlText(home)}</string>
	</dict>
	<key>StandardOutPath</key>
	<string>${xmlText(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlText(logPath)}</string>
</dict>
</plist>
`
}

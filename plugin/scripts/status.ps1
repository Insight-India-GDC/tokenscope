# /tokenscope:status for Windows WITHOUT Node (#408 S5) -- the PowerShell twin of
# the two local probes in status.mjs. Run as:
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
#     -File "<plugin>\scripts\status.ps1"
#
# 1. EMISSION PROBE. Runs the real emit path (otel-headers-helper.ps1, next to
#    this file, in a child PowerShell) and classifies its exit code + the failure
#    sentinel + the #409 degraded marker with the SAME verdict tree and the SAME
#    wording as interpretEmissionProbe in status.mjs. The bearer the helper
#    prints is read only to see whether an Authorization header is present; it is
#    never printed, logged or kept.
# 2. MCP-AUTH PROBE. Does Claude Code's own credential store
#    (<profile>\.claude\.credentials.json) hold a `.mcpOAuth` key for the
#    TokenScope plugin server (`plugin:tokenscope:tokenscope` or
#    `plugin:tokenscope:tokenscope|...`)? Only the KEY is looked at; no token
#    value is read into a variable that is printed.
#
# Output: one JSON object on stdout, the same keys status.mjs prints (`project`
# is null: the repo project check needs Node). Exit 0 whatever the verdict.
#
# The verdict tree is pinned against interpretEmissionProbe by
# tests/unit/plugin/status-ps1.test.ts (shared fixture table, run under pwsh).
# Dot-sourcing this file defines the functions without running the probes; the
# test uses that.
#
# WRITTEN TO WINDOWS POWERSHELL 5.1, ASCII only (5.1 reads a BOM-less script as
# the ANSI code page). The em dash and arrow in the shared wording are built from
# code points, and the JSON output escapes every non-ASCII character.

# The first statement, for the reason given in otel-headers-helper.ps1: the
# environment is repo-mergeable, and PSModulePath decides which ConvertFrom-Json
# runs.
$env:PSModulePath = $PSHOME + [IO.Path]::DirectorySeparatorChar + 'Modules'
# PATH next, for the same reason (otel-headers-helper.sh pins TRUSTED_PATH):
# nothing here runs a program by name, and nothing added later may find one
# the repository put on PATH. Windows only; off Windows only tests run this.
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $env:PATH = [Environment]::SystemDirectory + ';' + [Environment]::SystemDirectory + '\WindowsPowerShell\v1.0' }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Dash = [string][char]0x2014

# -- small JSON readers (StrictMode-safe) ----------------------------------------
function Get-Prop($Obj, [string]$Name) {
  if ($null -eq $Obj -or -not ($Obj -is [Management.Automation.PSCustomObject])) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

# pwsh 7 turns ISO date strings into DateTime unless told not to (7.5+:
# -DateKind String); 5.1 leaves them as strings. Strings on both, so a
# sentinel's `ts` reads back exactly as written.
$JsonArgs = @{}
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $JsonArgs['DateKind'] = 'String' }

function ConvertFrom-JsonText([string]$Text) {
  return ($Text | ConvertFrom-Json @JsonArgs)
}

function Read-JsonOrNull([string]$Path) {
  try {
    if (-not [IO.File]::Exists($Path)) { return $null }
    $o = ConvertFrom-JsonText ([IO.File]::ReadAllText($Path))
    if ($o -is [Management.Automation.PSCustomObject]) { return $o }
    return $null
  } catch { return $null }
}

# JavaScript truthiness for the values a sentinel/marker can carry.
function Test-Truthy($v) {
  if ($null -eq $v) { return $false }
  if ($v -is [string]) { return $v.Length -gt 0 }
  if ($v -is [bool]) { return $v }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) { return ($v -ne 0) }
  return $true
}

# Number.isFinite: a JSON NUMBER only, never a numeric string.
function Test-FiniteNumber($v) {
  if ($v -is [int] -or $v -is [long] -or $v -is [decimal]) { return $true }
  if ($v -is [double]) { return -not ([double]::IsNaN($v) -or [double]::IsInfinity($v)) }
  return $false
}

# JavaScript Number(x) for the shapes expires_at takes (number, numeric string,
# null/absent). Anything else is NaN.
function ConvertTo-JsNumber($v) {
  if ($null -eq $v) { return [double]0 }
  if (Test-FiniteNumber $v) { return [double]$v }
  if ($v -is [string]) {
    $t = $v.Trim()
    if ($t -eq '') { return [double]0 }
    $d = 0.0
    if ([double]::TryParse($t, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d }
  }
  return [double]::NaN
}

function Format-JsNumber($v) {
  return ([double]$v).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
}

# degradedExpiryNote (plugin-runtime.mjs), same phrases.
function Get-DegradedExpiryNote($Degraded, [long]$NowSec) {
  $exp = ConvertTo-JsNumber (Get-Prop $Degraded 'expires_at')
  if ([double]::IsNaN($exp) -or [double]::IsInfinity($exp) -or $exp -le 0) { return 'cached bearer expiry unknown' }
  $epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
  $iso = $epoch.AddSeconds($exp).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
  if ($exp -le $NowSec) { return "cached bearer EXPIRED at $iso $Dash exports are probably being refused" }
  return "cached bearer valid until $iso"
}

function Get-NowSec {
  $epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
  return [long][Math]::Floor(([DateTime]::UtcNow - $epoch).TotalSeconds)
}

# interpretEmissionProbe (status.mjs), branch for branch.
function Get-EmissionVerdict($Status, [bool]$HasAuth, $Sentinel, $Degraded, [long]$NowSec = (Get-NowSec)) {
  if ($Status -eq 0 -and $null -ne $Status -and $HasAuth -and (Test-Truthy $Degraded)) {
    $reason = Get-Prop $Degraded 'reason'
    if (-not (Test-Truthy $reason)) { $reason = 'TokenScope unreachable' }
    $since = Get-Prop $Degraded 'ts'
    if (-not (Test-Truthy $since)) { $since = 'unknown time' }
    $note = Get-DegradedExpiryNote $Degraded $NowSec
    return [ordered]@{
      emitting     = $true
      degraded     = $true
      probe_status = 0
      message      = "DEGRADED: TokenScope is unreachable ($reason; since $since). Still sending on the cached credential ($note), but it was NOT verified. Run /tokenscope:status again once TokenScope is reachable."
    }
  }
  if ($Status -eq 0 -and $null -ne $Status -and $HasAuth) {
    return [ordered]@{
      emitting     = $true
      probe_status = 200
      message      = 'OK: this computer can send usage to TokenScope. This checks the credential only; it cannot see whether your usage has arrived.'
    }
  }
  if ($Status -eq 0 -and $null -ne $Status) {
    return [ordered]@{
      emitting     = $false
      probe_status = $null
      message      = 'ERROR: the helper finished but returned no credential. Run /tokenscope:status again; if it keeps happening, run /tokenscope:setup.'
    }
  }
  $httpRaw = Get-Prop $Sentinel 'http_status'
  $http = $null
  if (Test-FiniteNumber $httpRaw) { $http = $httpRaw }
  $reason = Get-Prop $Sentinel 'message'
  if (-not (Test-Truthy $reason)) { $reason = 'credential check failed' }
  if ($null -ne $http) { $httpText = Format-JsNumber $http }
  if ($null -ne $http -and ($http -eq 401 -or $http -eq 403 -or $http -eq 404)) {
    $message = "NOT SENDING: $reason (HTTP $httpText). Usage is being dropped. Run /tokenscope:setup to reconnect this computer."
  } elseif ($null -ne $http -and $http -eq 0) {
    $message = "UNVERIFIED: $reason. Usually a short network blip. Run /tokenscope:status again; if it keeps failing, usage may be dropped."
  } elseif ($null -eq $http) {
    $message = 'NOT SENDING: the helper failed without saying why. Usage may be dropped. Run /tokenscope:status again; if it keeps failing, run /tokenscope:setup.'
  } else {
    $message = "NOT SENDING: $reason (HTTP $httpText). Usage may be dropped. Run /tokenscope:status again, or run /tokenscope:setup."
  }
  return [ordered]@{ emitting = $false; probe_status = $http; message = $message }
}

# isMcpAuthed (status.mjs).
function Test-McpAuthed($Creds) {
  $mcp = Get-Prop $Creds 'mcpOAuth'
  if (-not ($mcp -is [Management.Automation.PSCustomObject])) { return $false }
  foreach ($p in $mcp.PSObject.Properties) {
    $k = $p.Name
    if ($k -ceq 'plugin:tokenscope:tokenscope' -or $k.StartsWith('plugin:tokenscope:tokenscope|', [StringComparison]::Ordinal)) { return $true }
  }
  return $false
}

# Every non-ASCII character as \uXXXX, so the console code page cannot mangle it.
function ConvertTo-AsciiJson($Value) {
  $json = $Value | ConvertTo-Json -Depth 6
  $sb = New-Object Text.StringBuilder
  foreach ($ch in $json.ToCharArray()) {
    if ([int]$ch -gt 127) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) } else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

# A Windows command-line argument. Paths never contain `"` on Windows; refuse
# rather than mis-quote one.
function ConvertTo-Arg([string]$s) {
  if ($s.Contains('"')) { throw 'argument contains a double quote' }
  if ($s.EndsWith('\')) { $s = $s + '\' }
  return '"' + $s + '"'
}

# safeProcessEnv (plugin-runtime.mjs) for the child, on a ProcessStartInfo's
# environment: the keys a repository's settings env must not hand the helper.
#   - .NET profiler / runtime hooks (COR_*, CORECLR_*, COMPlus_*, DOTNET_*):
#     each can load a DLL of the repository's choosing into the child.
#   - PSModulePath: the child resets it itself, but it is set here too.
#   - the TokenScope keys that steer a credential-bearing call or where a
#     credential is written; the restorable ones come back from the device's
#     own <profile>\.claude\settings.json, as in safeProcessEnv.
$RepoUntrustedKeys = @('TOKENSCOPE_BEARER_ENDPOINT', 'TOKENSCOPE_OAUTH_TOKEN_ENDPOINT', 'TOKENSCOPE_OAUTH_CLIENT_ID',
  'TOKENSCOPE_OAUTH_REFRESH_TOKEN', 'TOKENSCOPE_READ_CLIENT_ID', 'TOKENSCOPE_READ_REFRESH_TOKEN', 'TOKENSCOPE_SESSION_TOKEN',
  'TOKENSCOPE_DCE_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')
$RepoUntrustedNoRestore = @('TOKENSCOPE_STATE_DIR', 'TOKENSCOPE_API_BASE')

function Set-SafeChildEnvironment($Psi, $GlobalEnv) {
  $vars = $Psi.EnvironmentVariables
  foreach ($k in @($vars.Keys)) {
    $u = ([string]$k).ToUpperInvariant()
    if ($u.StartsWith('COR_') -or $u.StartsWith('CORECLR_') -or $u.StartsWith('COMPLUS_') -or $u.StartsWith('DOTNET_') -or
        ($RepoUntrustedKeys -contains $u) -or ($RepoUntrustedNoRestore -contains $u)) {
      $vars.Remove($k)
    }
  }
  $vars['PSModulePath'] = $PSHOME + [IO.Path]::DirectorySeparatorChar + 'Modules'
  foreach ($k in $RepoUntrustedKeys) {
    $v = Get-Prop $GlobalEnv $k
    if ($v -is [string]) { $vars[$k] = $v }
  }
}

# Run the helper in a CHILD PowerShell -- the same executable running this script,
# by its own module path, never by name through PATH -- and keep only the exit
# code and whether stdout carried an Authorization header. Both pipes are read
# asynchronously so the timeout bounds the whole run (a synchronous read would
# wait for the child to close stdout, however long that takes); on timeout the
# child is killed.
function Invoke-EmitHelper([string]$Helper, [string]$StateDir, [string]$Tool, $GlobalEnv = $null, [int]$TimeoutMs = 60000) {
  $exe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (ConvertTo-Arg $Helper) +
    ' --state-dir ' + (ConvertTo-Arg $StateDir) + ' --tool ' + $Tool
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  Set-SafeChildEnvironment $psi $GlobalEnv
  $proc = [Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($TimeoutMs)) {
    try { $proc.Kill() } catch { }
    return @{ status = $null; hasAuth = $false }
  }
  # The no-argument wait also waits for the redirected streams to drain.
  $proc.WaitForExit()
  $out = $outTask.Result
  [void]$errTask.Result
  $hasAuth = $false
  try {
    $o = ConvertFrom-JsonText $out
    $a = Get-Prop $o 'Authorization'
    $hasAuth = ($a -is [string] -and $a.Length -gt 0)
  } catch { $hasAuth = $false }
  $out = $null
  return @{ status = $proc.ExitCode; hasAuth = $hasAuth }
}

function Invoke-Status {
  $profileDir = [Environment]::GetFolderPath('UserProfile')
  $result = [ordered]@{
    emitting     = $false
    probe        = [ordered]@{ status = $null; message = '' }
    project      = $null
    last_failure = $null
    mcp_authed   = $false
    runtime      = 'powershell'
    needs_node   = @('status line', 'backfill', 'repo project pin and check')
  }
  if ([string]::IsNullOrEmpty($profileDir)) {
    $result.probe.message = 'This account has no profile directory; TokenScope cannot run here.'
    return $result
  }
  $stateDir = [IO.Path]::Combine($profileDir, '.tokenscope')
  $tool = 'claude-code'
  $store = [IO.Path]::Combine($stateDir, "config.$tool.json")
  $settings = Read-JsonOrNull ([IO.Path]::Combine($profileDir, '.claude', 'settings.json'))
  $settingsRt = Get-Prop (Get-Prop $settings 'env') 'TOKENSCOPE_OAUTH_REFRESH_TOKEN'
  $helper = [IO.Path]::Combine($PSScriptRoot, 'otel-headers-helper.ps1')

  if (-not [IO.File]::Exists($store) -and -not (Test-Truthy $settingsRt)) {
    $verdict = [ordered]@{
      emitting     = $false
      probe_status = $null
      message      = "Not configured: this computer is not set up for TokenScope ($store). Run /tokenscope:setup, then restart Claude Code."
    }
  } elseif (-not [IO.File]::Exists($helper)) {
    $verdict = [ordered]@{
      emitting     = $false
      probe_status = $null
      message      = 'Headers helper not found ' + $Dash + ' is the plugin installed?'
    }
  } else {
    $run = Invoke-EmitHelper $helper $stateDir $tool (Get-Prop $settings 'env')
    $verdict = Get-EmissionVerdict $run.status $run.hasAuth `
      (Read-JsonOrNull ([IO.Path]::Combine($stateDir, "emit-failure.$tool.json"))) `
      (Read-JsonOrNull ([IO.Path]::Combine($stateDir, "emit-degraded.$tool.json")))
  }
  $result.emitting = $verdict.emitting
  $result.probe.status = $verdict.probe_status
  $result.probe.message = $verdict.message
  $result.last_failure = Read-JsonOrNull ([IO.Path]::Combine($stateDir, "emit-failure.$tool.json"))
  $other = Read-JsonOrNull ([IO.Path]::Combine($stateDir, 'emit-failure.copilot-cli.json'))
  if ($null -ne $other) {
    $o = [ordered]@{}
    foreach ($p in $other.PSObject.Properties) { $o[$p.Name] = $p.Value }
    $o['fix'] = 'Run TokenScope setup in a Copilot CLI session.'
    $result['copilot_lane_failure'] = $o
  }
  $creds = Read-JsonOrNull ([IO.Path]::Combine($profileDir, '.claude', '.credentials.json'))
  $result.mcp_authed = Test-McpAuthed $creds
  # Claude Desktop only (desktop-env.mjs): its sessions are attributed through the
  # user environment, so check it carries this device.
  if (Test-TsTrustedDesktop ([IO.Path]::Combine($profileDir, '.claude', 'settings.json'))) {
    $attrs = [string](Get-Prop (Get-Prop $settings 'env') 'OTEL_RESOURCE_ATTRIBUTES')
    $mine = if ($attrs -match '(?:^|,)tokenscope\.instance_id=([^,]+)') { $Matches[1] } else { '' }
    $login = [string][Environment]::GetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES', 'User')
    $dv = 'missing'
    if ($login) {
      $dv = 'mismatch'
      if ($mine -and $login -match '(?:^|,)tokenscope\.instance_id=([^,]+)' -and $Matches[1] -ieq $mine) { $dv = 'ok' }
    }
    $d = [ordered]@{ verdict = $dv }
    if ($dv -ne 'ok') { $d['fix'] = 'Run /tokenscope:setup in this Claude app session, then quit the app completely and open it again.' }
    $result['desktop_env'] = $d
  }
  return $result
}

# Claude Desktop gate (desktop-env.mjs): the app's CLAUDE_CODE_ENTRYPOINT, and not
# one a PROJECT settings file (.claude\settings.json or settings.local.json, from
# the working directory up) supplied: Claude Code applies a project's env to the
# session, so a checked-out repository could otherwise switch this on.
function Test-TsTrustedDesktop([string]$UserSettings) {
  if ("$env:CLAUDE_CODE_ENTRYPOINT".Trim() -ne 'claude-desktop') { return $false }
  $dir = (Get-Location).ProviderPath
  while ($dir) {
    foreach ($f in @('settings.json', 'settings.local.json')) {
      $p = [IO.Path]::Combine($dir, '.claude', $f)
      if ($p -ieq $UserSettings -or -not [IO.File]::Exists($p)) { continue }
      try {
        $j = [IO.File]::ReadAllText($p) | ConvertFrom-Json
        if ($j.env -and ($j.env.PSObject.Properties.Name -contains 'CLAUDE_CODE_ENTRYPOINT')) { return $false }
      } catch { }
    }
    $parent = [IO.Path]::GetDirectoryName($dir)
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  return $true
}

if ($MyInvocation.InvocationName -ne '.') {
  if ($args.Count -gt 0) {
    [Console]::Error.WriteLine('status.ps1 takes no arguments')
    exit 2
  }
  $r = $null
  try {
    $r = Invoke-Status
  } catch {
    $r = [ordered]@{ ok = $false; error = 'status probe failed: ' + $_.Exception.GetType().Name }
  }
  [Console]::Out.Write((ConvertTo-AsciiJson $r) + "`n")
  [Console]::Out.Flush()
  exit 0
}

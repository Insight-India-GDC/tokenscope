# claude-redeem.ps1 - the PowerShell twin of claude-redeem.mjs, for a Windows
# device WITHOUT Node (#408 S3).
#
# Same job, same argv, same files: redeem the one-time handoff code that
# provision_emit returned, process to server (never through the chat), then
# write this device's emit enrolment:
#   <profile>\.tokenscope\config.claude-code.json   the v2 device store
#   <profile>\.claude\settings.json                  otelHeadersHelper + env
# and, for a --settings-path target, list it in
#   <state>\settings-files.claude-code.json
# (and, when <state> is not <profile>\.tokenscope, index it with its state dir
# in <profile>\.tokenscope\isolated-settings-files.claude-code.json, the store
# session start always reads) so a later plugin update can rebuild its helper
# command.
#
# The output must be what the Node redeem writes on the same fixture, except
# that the helper record says platform 'win32' and otelHeadersHelper is the
# PowerShell command env-builder.mjs's buildHelperCommand builds for win32 -
# run from a snapshot of the helper in <state>\helper\scripts (see
# Copy-TsHelperSnapshot), not from the plugin install.
# tests/unit/plugin/claude-redeem-ps1.test.ts runs both and compares.
#
# It states `X-TokenScope-Setup-Mode: emit-only` on its one POST. The server
# records that beside the device (diagnostics only; nothing gates on it).
#
# ARGV IS MODEL-COMPOSED (see argv-guard.mjs for the full argument). So, as in
# the Node redeem:
#   - an unknown --flag is refused, and a flag missing its value is refused;
#   - --api-base may only SELECT among origins this device already knows
#     (loopback, the packaged default, the plugin's configured server_url in
#     managed or user settings, the tokenscope MCP registration in the user's
#     own config); anything else is warned about and ignored;
#   - --settings-path / --state-dir must resolve inside the user's profile and
#     outside any git repository, because they receive the durable credential.
#
# The profile is [Environment]::GetFolderPath('UserProfile'), never
# $env:USERPROFILE: Claude Code merges a repository's settings env into the
# processes it spawns, so an environment variable can be planted by a repo.
#
# Never prints the refresh token or the handoff code.
#
# Windows PowerShell 5.1 syntax. ASCII only (5.1 reads a BOM-less script in the
# ANSI code page). Runs under pwsh 7 on Linux for the test suite.

# FIRST: module auto-loading must come from PowerShell's own directory only, so
# a planted PSModulePath cannot substitute a cmdlet this script runs.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
# PATH next, for the same reason (otel-headers-helper.sh pins TRUSTED_PATH):
# nothing here runs a program by name, and nothing added later may find one
# the repository put on PATH. Windows only; off Windows only tests run this.
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $env:PATH = [Environment]::SystemDirectory + ';' + [Environment]::SystemDirectory + '\WindowsPowerShell\v1.0' }
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. ([System.IO.Path]::Combine($PSScriptRoot, 'ps-json.ps1'))
. ([System.IO.Path]::Combine($PSScriptRoot, 'claude-config-dir.ps1'))

# The packaged default server is NOT restated here: it is read from the
# plugin's own .claude-plugin/plugin.json (userConfig.server_url.default), the
# value api-base.mjs's DEFAULT_API_BASE is gated to equal. The public build
# ships it empty, which means "no default" (#415).
$Tool = 'claude-code'
$RetiredEnvKeys = @('TOKENSCOPE_SESSION_TOKEN', 'TOKENSCOPE_READ_REFRESH_TOKEN', 'TOKENSCOPE_READ_CLIENT_ID')
# claude-redeem.mjs STORE_ONLY_ENV_KEYS: in the device store, never in settings.json,
# whose env block every process Claude Code spawns inherits.
$StoreOnlyEnvKeys = @('TOKENSCOPE_OAUTH_REFRESH_TOKEN')



function Write-TsOut([string]$Line) { [Console]::Out.WriteLine($Line) }
function Write-TsErr([string]$Line) { [Console]::Error.WriteLine($Line) }



# ---- URLs (endpoint-guard.mjs) ---------------------------------------------

function Test-TsLoopbackHost([string]$HostName) {
  $h = $HostName.ToLowerInvariant()
  return ($h -eq '127.0.0.1' -or $h -eq 'localhost' -or $h -eq '::1' -or $h -eq '[::1]')
}

# An absolute http(s)-style URL, or $null. [Uri] calls '/x' an absolute file
# URI on Linux; the scheme checks below refuse that like Node's 'not-a-url'.
function Get-TsUri([string]$Value) {
  $u = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$u)) { return $null }
  return $u
}

# endpoint-guard.mjs assertSafeEndpoint. Returns the Uri, or throws with a
# value-free reason.
function Assert-TsSafeEndpoint([string]$Value, [string]$Label, [bool]$AllowLoopback) {
  $t = ''
  if ($null -ne $Value) { $t = $Value.Trim() }
  if (-not $t) { throw (New-TsError "$Label is unsafe (empty)" 'empty') }
  if ($t.StartsWith('-')) { throw (New-TsError "$Label is unsafe (leading-dash)" 'leading-dash') }
  $u = Get-TsUri $t
  if ($null -eq $u) { throw (New-TsError "$Label is unsafe (not-a-url)" 'not-a-url') }
  if ($AllowLoopback -and (Test-TsLoopbackHost $u.Host)) { return $u }
  if ($u.Scheme -ne 'https') { throw (New-TsError "$Label is unsafe (insecure-scheme)" 'insecure-scheme') }
  return $u
}

# WHATWG URL#origin for http(s); $null for anything else.
function Get-TsOrigin([string]$Value) {
  if (-not $Value -or -not $Value.Trim()) { return $null }
  $u = Get-TsUri $Value.Trim()
  if ($null -eq $u) { return $null }
  if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') { return $null }
  $h = $u.Host
  try { if ($u.IdnHost) { $h = $u.IdnHost } } catch { }
  if ($h -match ':' -and -not $h.StartsWith('[')) { $h = '[' + $h + ']' }
  $o = $u.Scheme + '://' + $h.ToLowerInvariant()
  if (-not $u.IsDefaultPort) { $o += ':' + $u.Port }
  return $o
}

# WHATWG URL#host (lower-cased), or ''.
function Get-TsHost([string]$Value) {
  if (-not $Value) { return '' }
  $u = Get-TsUri $Value.Trim()
  if ($null -eq $u) { return '' }
  if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') { return '' }
  $h = $u.Host.ToLowerInvariant()
  if (-not $u.IsDefaultPort) { $h += ':' + $u.Port }
  return $h
}

# device-store.mjs bearerInstance: the id in a .../instances/<id>/bearer URL.
function Get-TsBearerInstance([string]$Value) {
  $u = Get-TsUri ([string]$Value)
  if ($null -eq $u) { return '' }
  if ($u.Query.Length -gt 1 -or $u.Fragment.Length -gt 1) { return '' }
  $m = [regex]::Match($u.AbsolutePath, '^(?:.*/)?instances/([^/]+)/bearer$')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

# device-store.mjs attrsTool / attrsInstance.
function Get-TsAttr([string]$Attrs, [string]$Prefix) {
  foreach ($part in ([string]$Attrs).Split(',')) {
    $t = $part.Trim()
    if ($t.StartsWith($Prefix, [System.StringComparison]::Ordinal)) { return $t.Substring($Prefix.Length) }
  }
  return ''
}

# statusline.mjs emitEnvLabel, for the environment-change note only.
function Get-TsEnvLabel($EnvObj) {
  $bearer = Get-TsHost (Get-TsJsonString $EnvObj 'TOKENSCOPE_BEARER_ENDPOINT')
  $otlp = Get-TsHost (Get-TsJsonString $EnvObj 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')
  if (-not $bearer -and -not $otlp) { return $null }
  $m = [regex]::Match("$bearer $otlp", '\btokenscope-(dev|sandbox|staging|production|prod)\b')
  if ($m.Success) {
    $name = $m.Groups[1].Value
    if ($name -eq 'production') { $name = 'prod' }
    return $name.Substring(0, 1).ToUpperInvariant() + $name.Substring(1)
  }
  $local = '^(localhost|127\.0\.0\.1|\[::1\])(:|$)'
  if ($bearer -match $local -or $otlp -match $local) { return 'Local' }
  if ($bearer) { return $bearer }
  return $otlp
}

# ---- argv (argv-guard.mjs) ---------------------------------------------------

function Get-TsFlagValue($Argv, [int]$Index, [string]$Flag, [bool]$AllowLeadingDash) {
  $v = $null
  if ($Index -lt $Argv.Count) { $v = $Argv[$Index] }
  if ($null -eq $v -or [string]$v -eq '') { throw (New-TsError "$(Get-TsSafeToken $Flag) requires a value" 'missing-value') }
  $v = [string]$v
  if (-not $AllowLeadingDash -and $v.StartsWith('--')) {
    throw (New-TsError "$(Get-TsSafeToken $Flag) requires a value (got another flag)" 'missing-value')
  }
  return $v
}





function Read-TsArgs($Argv) {
  $out = @{ HandoffCode = $null; ApiBase = $null; InstanceId = $null; SettingsPath = $null; StateDir = $null }
  $i = 0
  while ($i -lt $Argv.Count) {
    $flag = [string]$Argv[$i]
    switch -CaseSensitive ($flag) {
      '--handoff-code' { $i++; $out.HandoffCode = Get-TsFlagValue $Argv $i $flag $true }
      '--api-base' { $i++; $out.ApiBase = Get-TsFlagValue $Argv $i $flag $false }
      '--instance-id' { $i++; $out.InstanceId = Get-TsFlagValue $Argv $i $flag $false }
      '--state-dir' {
        $i++
        $out.StateDir = Resolve-TsConfinedPath (Get-TsFlagValue $Argv $i $flag $false) $flag @() $true
      }
      '--settings-path' {
        $i++
        $out.SettingsPath = Resolve-TsConfinedPath (Get-TsFlagValue $Argv $i $flag $false) $flag @('settings.json') $true
      }
      default {
        if ($flag.Trim()) {
          if ($flag.StartsWith('--')) { throw (New-TsError "unknown flag: $(Get-TsSafeToken $flag)" 'unknown-flag') }
          if ($out.HandoffCode) { throw (New-TsError 'unexpected extra argument' 'extra-argument') }
          $out.HandoffCode = $flag
        }
      }
    }
    $i++
  }
  return $out
}

# ---- API base (api-base.mjs + mcp-origin.mjs) ----------------------------------

function Read-TsJsonFile([string]$Path) {
  try {
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    return ,(ConvertFrom-TsJson (ConvertFrom-TsUtf8 ([System.IO.File]::ReadAllBytes($Path))))
  } catch {
    return $null
  }
}

function Get-TsMcpUrlOrigin($Doc) {
  $servers = Get-TsJsonMember $Doc 'mcpServers'
  $ts = Get-TsJsonMember $servers 'tokenscope'
  return (Get-TsOrigin (Get-TsJsonString $ts 'url'))
}

# mcp-origin.mjs discoverMcpOrigin(scriptsDir, { client: 'claude' }): this
# directory's registration in ~/.claude.json, then the global one there, then
# Copilot's user config, then the bundle. NEVER the working directory's own
# .mcp.json: a repository writes that file.
function Find-TsMcpOrigin([string]$ProfileDir, [string]$ScriptsDir) {
  $doc = Read-TsJsonFile ([System.IO.Path]::Combine($ProfileDir, '.claude.json'))
  if ($null -ne $doc) {
    $projects = Get-TsJsonMember $doc 'projects'
    $cwd = (Get-Location).ProviderPath
    # Node keys on realpath(cwd); Claude Code on Windows may key with forward
    # slashes. Both are keys into the user's own file, so trying both only
    # chooses among registrations the user made.
    foreach ($key in @($cwd, ($cwd -replace '\\', '/'))) {
      $o = Get-TsMcpUrlOrigin (Get-TsJsonMember $projects $key)
      if ($o) { return $o }
    }
    $o = Get-TsMcpUrlOrigin $doc
    if ($o) { return $o }
  }
  foreach ($p in @(
      [System.IO.Path]::Combine([System.IO.Path]::Combine($ProfileDir, '.copilot'), 'mcp-config.json'),
      [System.IO.Path]::Combine([System.IO.Path]::Combine($ScriptsDir, '..'), '.mcp.json'),
      [System.IO.Path]::Combine($ScriptsDir, '.mcp.json'))) {
    $o = Get-TsMcpUrlOrigin (Read-TsJsonFile $p)
    if ($o) { return $o }
  }
  return $null
}

# argv-guard.mjs acceptApiBaseArg: a rejected --api-base is warned about and
# ignored, never fatal; resolution continues from local configuration.
function Select-TsApiBaseArg([string]$Value, [string[]]$Allowed) {
  if (-not $Value -or -not $Value.Trim()) { return $null }
  $reason = $null
  $origin = $null
  try {
    $u = Assert-TsSafeEndpoint $Value '--api-base' $true
    if ($u.UserInfo) { $reason = 'userinfo' }
    elseif (-not ($u.Scheme -eq 'https' -or ((Test-TsLoopbackHost $u.Host) -and $u.Scheme -eq 'http'))) { $reason = 'insecure-scheme' }
    else {
      $origin = Get-TsOrigin $Value
      if (-not (Test-TsLoopbackHost $u.Host)) {
        $known = @($Allowed | ForEach-Object { Get-TsOrigin $_ } | Where-Object { $_ })
        if (-not ($known -ccontains $origin)) { $reason = 'origin-not-allowed' }
      }
    }
  } catch {
    $reason = 'invalid'
    if ($_.Exception.Data.Contains('reason')) { $reason = [string]$_.Exception.Data['reason'] }
  }
  if ($reason) {
    Write-TsErr ("[tokenscope] WARN: ignoring --api-base ($reason) - it does not name " +
      'loopback, the packaged deployment, your configured TokenScope server URL, or the TokenScope MCP ' +
      'server registered in your own client config. Resolving the redeem host from local configuration ' +
      "instead. If this deployment really is yours, set it as the plugin's server URL (Claude Code: " +
      '/plugin, tokenscope, Configure).')
    return $null
  }
  return $origin
}

# The plugin.json `server_url` default, or '' (absent, unreadable, or empty).
function Get-TsPackagedDefault {
  $doc = Read-TsJsonFile ([System.IO.Path]::Combine([System.IO.Path]::Combine([System.IO.Path]::Combine($PSScriptRoot, '..'), '.claude-plugin'), 'plugin.json'))
  $opt = Get-TsJsonMember (Get-TsJsonMember $doc 'userConfig') 'server_url'
  return (Get-TsJsonString $opt 'default').Trim()
}

# api-base.mjs managedSettingsPath. FIXED paths: %ProgramFiles% is environment
# a repository can set.
function Get-TsManagedSettingsPath {
  if (Test-TsWindows) { return 'C:\Program Files\ClaudeCode\managed-settings.json' }
  if (Test-Path -LiteralPath '/System/Library/CoreServices') { return '/Library/Application Support/ClaudeCode/managed-settings.json' }
  return '/etc/claude-code/managed-settings.json'
}

# api-base.mjs ownMarketplace: from this install's own path,
# ...\plugins\cache\<marketplace>\tokenscope\<version>\scripts, else $null.
function Get-TsOwnMarketplace([string]$ScriptsDir) {
  $parts = $ScriptsDir.Split([System.IO.Path]::DirectorySeparatorChar)
  $i = [Array]::LastIndexOf($parts, 'cache')
  if ($i -lt 1 -or $parts[$i - 1] -cne 'plugins' -or $i + 2 -ge $parts.Count -or $parts[$i + 2] -cne 'tokenscope') { return $null }
  if (-not $parts[$i + 1]) { return $null }
  return $parts[$i + 1]
}

# api-base.mjs serverUrlFromSettings: pluginConfigs."tokenscope@<mkt>".options.server_url.
# This install's own marketplace key wins; otherwise every tokenscope@* value
# must agree, and disagreement is $null rather than a guess.
function Get-TsServerUrlFromSettings([string]$Path, $Marketplace) {
  $doc = Read-TsJsonFile $Path
  $configs = Get-TsJsonMember $doc 'pluginConfigs'
  if (-not (Test-TsJsonObject $configs)) { return $null }
  $valueOf = {
    param($key)
    $v = Get-TsJsonString (Get-TsJsonMember (Get-TsJsonMember $configs $key) 'options') 'server_url'
    if ($v.Trim()) { return $v.Trim() }
    return $null
  }
  if ($Marketplace) {
    $own = & $valueOf ('tokenscope@' + $Marketplace)
    if ($own) { return $own }
  }
  $values = New-Object 'System.Collections.Generic.List[string]'
  foreach ($k in @($configs.get_Keys())) {
    if (-not $k.StartsWith('tokenscope@', [System.StringComparison]::Ordinal)) { continue }
    $v = & $valueOf $k
    if ($v -and -not $values.Contains($v)) { $values.Add($v) }
  }
  if ($values.Count -eq 1) { return $values[0] }
  return $null
}

# api-base.mjs configuredServerUrl: managed settings, then the USER settings
# file under the profile. Never project or local settings (Claude Code ignores
# pluginConfigs there so a repository cannot set it), never CLAUDE_CONFIG_DIR
# or CLAUDE_PLUGIN_OPTION_* (environment a repository can set).
function Get-TsConfiguredServerUrl([string]$ProfileDir, [string]$ScriptsDir, [string]$ConfigDir = '') {
  $mkt = Get-TsOwnMarketplace $ScriptsDir
  $v = Get-TsServerUrlFromSettings (Get-TsManagedSettingsPath) $mkt
  if ($v) { return $v }
  # The install's own settings (#449), as api-base.mjs reads claudeSettingsPath.
  if (-not $ConfigDir) { $ConfigDir = [System.IO.Path]::Combine($ProfileDir, '.claude') }
  return (Get-TsServerUrlFromSettings ([System.IO.Path]::Combine($ConfigDir, 'settings.json')) $mkt)
}

# api-base.mjs resolveApiBase: arg, then a LOOPBACK TOKENSCOPE_API_BASE, then
# the configured server_url, then the discovered registration, then the
# packaged default. An invalid configured value is an ERROR, never skipped in
# favour of the default; no source at all is the "set your URL" error.
function Resolve-TsApiBase([string]$ArgBase, [string]$Configured, [string]$Discovered, [string]$PackagedDefault) {
  $envBase = ''
  if ($env:TOKENSCOPE_API_BASE) { $envBase = $env:TOKENSCOPE_API_BASE.Trim() }
  $envOk = $false
  if ($envBase) {
    $eu = Get-TsUri $envBase
    if ($null -ne $eu -and ($eu.Scheme -eq 'http' -or $eu.Scheme -eq 'https')) {
      $h = $eu.Host.Trim('[', ']').ToLowerInvariant()
      $envOk = ($h -eq 'localhost' -or $h -eq '127.0.0.1' -or $h -eq '::1')
    }
  }
  $raw = ''
  if ($ArgBase -and $ArgBase.Trim()) { $raw = $ArgBase.Trim() }
  elseif ($envOk) { $raw = $envBase }
  elseif ($Configured -and $Configured.Trim()) { $raw = $Configured.Trim() }
  elseif ($Discovered -and $Discovered.Trim()) { $raw = $Discovered.Trim() }
  elseif ($PackagedDefault -and $PackagedDefault.Trim()) { $raw = $PackagedDefault.Trim() }
  if (-not $raw) {
    throw (New-TsError ('No TokenScope server is configured. Set your TokenScope URL: in Claude Code run /plugin, ' +
        'choose tokenscope, then Configure, and paste the server URL from the Connect dialog of your ' +
        'TokenScope deployment.') 'server-unset')
  }
  $stripped = $raw.TrimEnd('/')
  try {
    [void](Assert-TsSafeEndpoint $stripped 'API base' $true)
  } catch {
    throw (New-TsError "API base is unsafe ($($_.Exception.Data['reason']))" 'unsafe-api-base')
  }
  return $stripped
}

# ---- the redeem response (claude-redeem.mjs) ---------------------------------

# device-store.mjs assertStoreConsistent for the claude-code lane.
function Assert-TsStoreConsistent($Store) {
  if (-not ($Store['version'] -is [System.Tuple[string]] -and $Store['version'].Item1 -eq '2')) { throw 'store version is not 2' }
  $str = { param($k) Get-TsJsonString $Store $k }
  if ((& $str 'tool') -cne $Tool) { throw "store tool `"$(& $str 'tool')`" is not `"$Tool`"" }
  foreach ($k in @('instance_id', 'oauth_refresh_token', 'oauth_token_endpoint', 'bearer_endpoint', 'otel_resource_attributes')) {
    if (-not (& $str $k)) { throw "store has no $k" }
  }
  foreach ($k in @('tool', 'instance_id', 'oauth_refresh_token', 'oauth_token_endpoint', 'bearer_endpoint', 'oauth_client_id', 'otel_resource_attributes')) {
    if ((& $str $k) -match '[\u0000-\u001f"\\]') { throw "store $k is not readable by the emit helper" }
  }
  foreach ($k in @('bearer_endpoint', 'oauth_token_endpoint')) {
    try { [void](Assert-TsSafeEndpoint (& $str $k) "store $k" $true) } catch { throw "store $k is unsafe ($($_.Exception.Data['reason']))" }
  }
  $instance = & $str 'instance_id'
  $attrs = & $str 'otel_resource_attributes'
  $t = Get-TsAttr $attrs 'tool='
  if ($t -cne $Tool) { throw "resource attributes name tool `"$t`", not `"$Tool`"" }
  $ai = Get-TsAttr $attrs 'tokenscope.instance_id='
  if ($ai -cne $instance) { throw "resource attributes name instance `"$ai`", not `"$instance`"" }
  $bi = Get-TsBearerInstance (& $str 'bearer_endpoint')
  if ($bi -cne $instance) { throw "bearer endpoint addresses instance `"$bi`", not `"$instance`"" }
}

# claude-redeem.mjs claudeStoreFields, in its key order.
function New-TsStoreFields([string]$RefreshToken, [string]$TokenEndpoint, [string]$BearerEndpoint, [string]$ClientId, [string]$LogsEndpoint, [string]$Attrs) {
  $s = New-TsJsonObject
  $s['version'] = [System.Tuple]::Create('2')
  $s['tool'] = $Tool
  $s['instance_id'] = Get-TsAttr $Attrs 'tokenscope.instance_id='
  $s['bearer_endpoint'] = $BearerEndpoint
  $s['oauth_token_endpoint'] = $TokenEndpoint
  $s['oauth_client_id'] = $ClientId
  $s['logs_endpoint'] = $LogsEndpoint
  $s['oauth_refresh_token'] = $RefreshToken
  $s['otel_resource_attributes'] = $Attrs
  return ,$s
}

# claude-redeem.mjs assertClaudeRedeemResponse. Throws a value-free message.
function Assert-TsRedeemResponse($Resp) {
  $telemetry = Get-TsJsonMember $Resp 'telemetry'
  $claude = Get-TsJsonMember $telemetry 'claude'
  if ((Get-TsJsonString $Resp 'tool') -eq 'copilot-cli' -or (-not (Test-TsJsonObject $claude) -and $null -ne (Get-TsJsonMember $telemetry 'copilot'))) {
    throw ('Redeem returned a Copilot bundle - provision_emit was called with tool=copilot-cli. ' +
      'Use copilot-redeem.mjs, or re-run provision_emit with tool=claude-code.')
  }
  $bearer = Get-TsJsonString $claude 'otel_headers_helper_url'
  $logs = Get-TsJsonString $claude 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'
  if (-not (Test-TsJsonObject $claude) -or -not $bearer -or -not $logs) {
    throw ("Redeem did not return a usable Claude Code bundle (bundle=$((Test-TsJsonObject $claude).ToString().ToLowerInvariant()) " +
      "bearer_endpoint=$(([bool]$bearer).ToString().ToLowerInvariant()) logs_endpoint=$(([bool]$logs).ToString().ToLowerInvariant())).")
  }
  foreach ($pair in @(@('otel_headers_helper_url', $bearer), @('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', $logs))) {
    try { [void](Assert-TsSafeEndpoint $pair[1] 'x' $true) } catch { throw "Redeem bundle's $($pair[0]) is unsafe ($($_.Exception.Data['reason']))" }
  }
  $attrs = Get-TsJsonString $claude 'OTEL_RESOURCE_ATTRIBUTES'
  if ($attrs -notmatch 'tokenscope\.instance_id=[^,\s]') {
    throw ('Redeem bundle is missing a non-empty OTEL_RESOURCE_ATTRIBUTES tokenscope.instance_id - ' +
      'refusing to enrol a device that would emit unattributable telemetry.')
  }
  foreach ($field in @('oauth_refresh_token', 'oauth_token_endpoint', 'oauth_client_id')) {
    if (-not (Get-TsJsonString $Resp $field)) { throw "Redeem response missing $field - server may be out of date." }
  }
  try { [void](Assert-TsSafeEndpoint (Get-TsJsonString $Resp 'oauth_token_endpoint') 'x' $true) } catch {
    throw "Redeem response's oauth_token_endpoint is unsafe ($($_.Exception.Data['reason']))"
  }
  Assert-TsStoreConsistent (New-TsStoreFields (Get-TsJsonString $Resp 'oauth_refresh_token') (Get-TsJsonString $Resp 'oauth_token_endpoint') $bearer (Get-TsJsonString $Resp 'oauth_client_id') $logs $attrs)
  return ,$claude
}

# A bundle value with claude-redeem.mjs's `?? default`: present (any type) wins.
function Get-TsBundleValue($Claude, [string]$Key, $Default) {
  if ((Test-TsJsonObject $Claude) -and $Claude.Contains($Key) -and $null -ne $Claude[$Key]) { return ,$Claude[$Key] }
  return $Default
}

# claude-redeem.mjs buildClaudeDeviceEnv, in its key order.
function New-TsDeviceEnv($Claude, $Resp) {
  $e = New-TsJsonObject
  $e['CLAUDE_CODE_ENABLE_TELEMETRY'] = '1'
  $e['OTEL_LOGS_EXPORTER'] = Get-TsBundleValue $Claude 'OTEL_LOGS_EXPORTER' 'otlp'
  $e['OTEL_METRICS_EXPORTER'] = Get-TsBundleValue $Claude 'OTEL_METRICS_EXPORTER' 'none'
  $e['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] = Get-TsBundleValue $Claude 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT' ''
  $e['OTEL_EXPORTER_OTLP_LOGS_PROTOCOL'] = Get-TsBundleValue $Claude 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL' 'http/protobuf'
  $e['OTEL_RESOURCE_ATTRIBUTES'] = Get-TsBundleValue $Claude 'OTEL_RESOURCE_ATTRIBUTES' ''
  $e['TOKENSCOPE_BEARER_ENDPOINT'] = Get-TsBundleValue $Claude 'otel_headers_helper_url' ''
  $rt = Get-TsJsonString $Resp 'oauth_refresh_token'
  $te = Get-TsJsonString $Resp 'oauth_token_endpoint'
  $ci = Get-TsJsonString $Resp 'oauth_client_id'
  if ($rt -and $te -and $ci) {
    $e['TOKENSCOPE_OAUTH_REFRESH_TOKEN'] = $rt
    $e['TOKENSCOPE_OAUTH_TOKEN_ENDPOINT'] = $te
    $e['TOKENSCOPE_OAUTH_CLIENT_ID'] = $ci
  }
  foreach ($k in $RetiredEnvKeys) { if ($e.Contains($k)) { $e.Remove($k) } }
  return ,$e
}

# ---- the helper command (env-builder.mjs buildHelperCommand, win32) ----------

# path.win32.isAbsolute
function Test-TsWin32Absolute([string]$P) {
  return ($P -match '^[\\/]' -or $P -match '^[A-Za-z]:[\\/]')
}

# path.win32.join(dir, leaf) for an absolute dir: separators become '\', runs
# collapse, '.' and '..' resolve.
function Join-TsWin32([string]$Dir, [string]$Leaf) {
  $p = ($Dir + '\' + $Leaf) -replace '/', '\'
  $prefix = ''
  $m = [regex]::Match($p, '^\\\\[^\\]+\\[^\\]+')
  if ($m.Success) { $prefix = $m.Value; $p = $p.Substring($m.Length) }
  elseif ($p -match '^[A-Za-z]:') { $prefix = $p.Substring(0, 2); $p = $p.Substring(2) }
  $segs = New-Object 'System.Collections.Generic.List[string]'
  foreach ($s in $p.Split('\')) {
    if ($s -eq '' -or $s -eq '.') { continue }
    if ($s -eq '..') { if ($segs.Count -gt 0) { $segs.RemoveAt($segs.Count - 1) }; continue }
    $segs.Add($s)
  }
  return $prefix + '\' + ($segs -join '\')
}

# env-builder.mjs quoteCmd.
function Format-TsCmdArg([string]$Value, [bool]$Always) {
  if ($Value -match '[\u0000-\u001f\u007f]') { throw 'helper command value has a control character' }
  if ($Value -match '["%]') { throw 'helper command value has a character cmd.exe would rewrite' }
  if (-not $Always -and $Value -cmatch '^[A-Za-z0-9_.\\/:@+,=-]+$') { return $Value }
  $m = [regex]::Match($Value, '\\+$')
  if ($m.Success) { $Value = $Value + $m.Value }
  return '"' + $Value + '"'
}

function New-TsHelperRecord([string]$StateDir) {
  $r = New-TsJsonObject
  $r['tool'] = $Tool
  $r['platform'] = 'win32'
  if ($StateDir) { $r['stateDir'] = $StateDir }
  return ,$r
}

# emit-helper-spawn.mjs windowsPowerShellPath, for the PERSISTED command: an
# absolute path, never the bare name. Claude Code runs the command through
# cmd.exe, which searches the current directory (the repository) before PATH,
# and a repository can set PATH. The fixed C:\Windows path first (what the Node
# builder writes), then the OS's own system directory - an API, not an
# environment variable. Off Windows only the test harness runs this, and it
# gets the fixed path, as buildHelperCommand does there.
function Get-TsPowerShellPath {
  $fixed = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-TsWindows)) { return $fixed }
  if ([System.IO.File]::Exists($fixed)) { return $fixed }
  $sys = [System.Environment]::SystemDirectory
  if ($sys -match '^[A-Za-z]:\\') {
    $p = $sys.TrimEnd('\') + '\WindowsPowerShell\v1.0\powershell.exe'
    if ([System.IO.File]::Exists($p)) { return $p }
  }
  throw 'Windows PowerShell was not found at an absolute path'
}

function New-TsHelperCommand($Record, [string]$ScriptsDir) {
  $sd = Get-TsJsonString $Record 'stateDir'
  if ($Record.Contains('stateDir')) {
    if (-not $sd -or $sd -match '[\u0000-\u001f"]') { throw 'helper record stateDir is not usable' }
    if (-not (Test-TsWin32Absolute $sd)) { throw 'helper record stateDir is not absolute' }
  }
  if (-not (Test-TsWin32Absolute $ScriptsDir)) { throw 'helper scripts dir is not an absolute path' }
  $script = Format-TsCmdArg (Join-TsWin32 $ScriptsDir 'otel-headers-helper.ps1') $true
  $cmd = (Format-TsCmdArg (Get-TsPowerShellPath) $true) + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $script + ' --tool ' + $Tool
  if ($Record.Contains('stateDir')) { $cmd += ' --state-dir ' + (Format-TsCmdArg $sd $false) }
  return $cmd
}

# ---- files -------------------------------------------------------------------

$Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false

function Set-TsOwnerOnly([string]$Path, [bool]$Directory) {
  # Windows: the profile's ACL already confines it to this user. Elsewhere
  # (pwsh, the test harness) mirror Node's 0600 / 0700.
  if (Test-TsWindows) { return }
  try {
    if ($Directory) { $mode = [System.IO.UnixFileMode]'UserRead, UserWrite, UserExecute' } else { $mode = [System.IO.UnixFileMode]'UserRead, UserWrite' }
    [System.IO.File]::SetUnixFileMode($Path, $mode)
  } catch { }
}

function New-TsDirectory([string]$Dir) {
  if (-not [System.IO.Directory]::Exists($Dir)) {
    [void][System.IO.Directory]::CreateDirectory($Dir)
    Set-TsOwnerOnly $Dir $true
  }
}

function New-TsTempPath([string]$Path) {
  $bytes = New-Object byte[] 6
  (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
  $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  return "$Path.tmp.$PID.$hex"
}

function Write-TsTemp([string]$Tmp, [string]$Text) {
  # Created empty and narrowed BEFORE the credential is written into it.
  [System.IO.File]::WriteAllBytes($Tmp, (New-Object byte[] 0))
  Set-TsOwnerOnly $Tmp $false
  [System.IO.File]::WriteAllText($Tmp, $Text, $Utf8NoBom)
}

# Atomic replace. Windows can refuse a replace while another process holds the
# target open; retry briefly rather than fail the enrolment on that.
function Move-TsIntoPlace([string]$Tmp, [string]$Path) {
  for ($n = 0; $n -lt 5; $n++) {
    try {
      if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Replace($Tmp, $Path, [NullString]::Value) }
      else { [System.IO.File]::Move($Tmp, $Path) }
      return
    } catch [System.IO.IOException] {
      if ($n -eq 4) { throw }
      Start-Sleep -Milliseconds 100
    } catch [System.UnauthorizedAccessException] {
      if ($n -eq 4) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
}

function Read-TsRaw([string]$Path) {
  if (-not [System.IO.File]::Exists($Path)) { return $null }
  return (ConvertFrom-TsUtf8 ([System.IO.File]::ReadAllBytes($Path)))
}

# A copy of $Source at $Path, atomically (temp + replace), so the helper never
# reads a half-written script.
function Copy-TsAtomic([string]$Source, [string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Source)
  New-TsDirectory ([System.IO.Path]::GetDirectoryName($Path))
  $tmp = New-TsTempPath $Path
  try {
    [System.IO.File]::WriteAllBytes($tmp, $bytes)
    Move-TsIntoPlace $tmp $Path
  } finally {
    if ([System.IO.File]::Exists($tmp)) { try { [System.IO.File]::Delete($tmp) } catch { } }
  }
}

# The EMIT-ONLY helper is a SNAPSHOT in the state dir, not the plugin install.
# `/plugin update` installs a new versioned cache dir and never rewrites
# otelHeadersHelper; only the Node session-start self-heal re-points it, and a
# device without Node has none. A command naming the install would keep running
# the old version's helper until that directory is garbage-collected, then stop
# emitting silently. The snapshot is refreshed by re-running setup; if Node is
# installed later, the self-heal recognises it and moves the command onto the
# active install. Layout mirrors the install, because the helper reads its
# version from ..\.claude-plugin\plugin.json:
#   <state>\helper\.claude-plugin\plugin.json
#   <state>\helper\scripts\otel-headers-helper.ps1
# Returns the snapshot's scripts dir.
function Copy-TsHelperSnapshot([string]$StateDir) {
  $root = [System.IO.Path]::Combine($StateDir, 'helper')
  $scripts = [System.IO.Path]::Combine($root, 'scripts')
  $manifest = [System.IO.Path]::Combine([System.IO.Path]::Combine([System.IO.Path]::Combine($PSScriptRoot, '..'), '.claude-plugin'), 'plugin.json')
  if ([System.IO.File]::Exists($manifest)) {
    Copy-TsAtomic $manifest ([System.IO.Path]::Combine([System.IO.Path]::Combine($root, '.claude-plugin'), 'plugin.json'))
  }
  Copy-TsAtomic ([System.IO.Path]::Combine($PSScriptRoot, 'otel-headers-helper.ps1')) ([System.IO.Path]::Combine($scripts, 'otel-headers-helper.ps1'))
  return $scripts
}

# plugin-runtime.mjs casWriteFile: render from the CURRENT bytes on every
# attempt; never rename over bytes another writer replaced meanwhile.
function Write-TsCas([string]$Path, [scriptblock]$Render) {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $raw = Read-TsRaw $Path
    $next = & $Render $raw
    if ($null -eq $next) { return 'no-change' }
    $tmp = New-TsTempPath $Path
    try {
      New-TsDirectory ([System.IO.Path]::GetDirectoryName($Path))
      Write-TsTemp $tmp $next
      if ((Read-TsRaw $Path) -cne $raw) { continue }
      Move-TsIntoPlace $tmp $Path
      return 'changed'
    } finally {
      if ([System.IO.File]::Exists($tmp)) { try { [System.IO.File]::Delete($tmp) } catch { } }
    }
  }
  return 'contended'
}

# claude-redeem.mjs writeSharedCredentialStore + plugin-runtime writeDeviceStore.
function Write-TsDeviceStore($Fields, [string]$Dir) {
  Assert-TsStoreConsistent $Fields
  $path = [System.IO.Path]::Combine($Dir, "config.$Tool.json")
  $tmp = $null
  try {
    New-TsDirectory $Dir
    $tmp = New-TsTempPath $path
    Write-TsTemp $tmp ((ConvertTo-TsJson $Fields) + "`n")
    Move-TsIntoPlace $tmp $path
  } catch {
    # Always fatal: settings.json no longer carries the credential.
    throw ("TokenScope: could not write the device credential store in $Dir. The emit helper " +
      'reads the durable credential only from that store, so this device would not emit. ' +
      'Enrolment is NOT complete: make the directory writable and re-run setup.')
  } finally {
    if ($tmp -and [System.IO.File]::Exists($tmp)) { try { [System.IO.File]::Delete($tmp) } catch { } }
  }
}

# plugin-runtime.mjs recordSettingsFile.
function Add-TsSettingsFile([string]$Dir, [string]$SettingsPath) {
  $listPath = [System.IO.Path]::Combine($Dir, "settings-files.$Tool.json")
  $result = Write-TsCas $listPath {
    param($raw)
    $files = New-Object 'System.Collections.Generic.List[string]'
    if ($null -ne $raw) {
      try {
        $arr = Get-TsJsonMember (ConvertFrom-TsJson $raw) 'files'
        if (Test-TsJsonArray $arr) { foreach ($f in $arr) { if ($f -is [string] -and $f) { $files.Add($f) } } }
      } catch { }
    }
    $next = New-TsJsonArray
    foreach ($f in $files) { if ($f -cne $SettingsPath) { $next.Add($f) } }
    $next.Add($SettingsPath)
    while ($next.Count -gt 32) { $next.RemoveAt(0) }
    $doc = New-TsJsonObject
    $doc['version'] = [System.Tuple]::Create('1')
    $doc['tool'] = $Tool
    $doc['files'] = $next
    $body = (ConvertTo-TsJson $doc) + "`n"
    if ($body -ceq $raw) { return $null }
    return $body
  }
  if ($result -eq 'contended') { throw 'contended' }
}

# plugin-runtime.mjs recordIsolatedSettingsFile: paths only, one entry per file.
function Add-TsIsolatedSettingsFile([string]$Dir, [string]$SettingsPath, [string]$StateDir) {
  $listPath = [System.IO.Path]::Combine($Dir, "isolated-settings-files.$Tool.json")
  $result = Write-TsCas $listPath {
    param($raw)
    $next = New-TsJsonArray
    if ($null -ne $raw) {
      try {
        $arr = Get-TsJsonMember (ConvertFrom-TsJson $raw) 'entries'
        if (Test-TsJsonArray $arr) {
          foreach ($e in $arr) {
            if (-not (Test-TsJsonObject $e)) { continue }
            $f = Get-TsJsonMember $e 'file'
            $d = Get-TsJsonMember $e 'stateDir'
            if (-not ($f -is [string] -and $f -and $d -is [string] -and $d)) { continue }
            if ($f -ceq $SettingsPath) { continue }
            $o = New-TsJsonObject
            $o['file'] = $f
            $o['stateDir'] = $d
            $next.Add($o)
          }
        }
      } catch { $next = New-TsJsonArray }
    }
    $o = New-TsJsonObject
    $o['file'] = $SettingsPath
    $o['stateDir'] = $StateDir
    $next.Add($o)
    while ($next.Count -gt 32) { $next.RemoveAt(0) }
    $doc = New-TsJsonObject
    $doc['version'] = [System.Tuple]::Create('1')
    $doc['tool'] = $Tool
    $doc['entries'] = $next
    $body = (ConvertTo-TsJson $doc) + "`n"
    if ($body -ceq $raw) { return $null }
    return $body
  }
  if ($result -eq 'contended') { throw 'contended' }
}

# claude-redeem.mjs writeClaudeSettings.
function Write-TsClaudeSettings([string]$SettingsPath, [string]$HelperCommand, $Record, $EnvBlock, [string]$StoreDir, [bool]$SessionScoped, [string]$IndexDir) {
  $fields = New-TsStoreFields (Get-TsJsonString $EnvBlock 'TOKENSCOPE_OAUTH_REFRESH_TOKEN') (Get-TsJsonString $EnvBlock 'TOKENSCOPE_OAUTH_TOKEN_ENDPOINT') (Get-TsJsonString $EnvBlock 'TOKENSCOPE_BEARER_ENDPOINT') (Get-TsJsonString $EnvBlock 'TOKENSCOPE_OAUTH_CLIENT_ID') (Get-TsJsonString $EnvBlock 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT') (Get-TsJsonString $EnvBlock 'OTEL_RESOURCE_ATTRIBUTES')
  Assert-TsStoreConsistent $fields
  $state = @{ Change = $null }
  $result = Write-TsCas $SettingsPath {
    param($raw)
    $existing = $null
    if ($null -ne $raw) {
      try { $existing = ConvertFrom-TsJson $raw } catch {
        throw "Existing $SettingsPath is not valid JSON - refusing to overwrite. Fix or move it, then re-run."
      }
    }
    # detectEnvChange: both bearer hosts present and different.
    $oldEnv = Get-TsJsonMember $existing 'env'
    $oldHost = Get-TsHost (Get-TsJsonString $oldEnv 'TOKENSCOPE_BEARER_ENDPOINT')
    $newHost = Get-TsHost (Get-TsJsonString $EnvBlock 'TOKENSCOPE_BEARER_ENDPOINT')
    $changed = [bool]$oldHost -and [bool]$newHost -and ($oldHost -cne $newHost)
    $oldLabel = Get-TsEnvLabel $oldEnv
    if (-not $oldLabel) { $oldLabel = $oldHost }
    $newLabel = Get-TsEnvLabel $EnvBlock
    if (-not $newLabel) { $newLabel = $newHost }
    $state.Change = @{ Changed = $changed; Old = $oldLabel; New = $newLabel }
    # env-builder.mjs mergeClaudeSettings.
    $merged = Copy-TsJsonSpread $existing
    $merged['otelHeadersHelper'] = $HelperCommand
    if ($changed) {
      $newEnv = Copy-TsJsonSpread $EnvBlock
    } else {
      $base = $null
      if ($merged.Contains('env')) { $base = $merged['env'] }
      $newEnv = Copy-TsJsonSpread $base
      foreach ($k in @($EnvBlock.get_Keys())) { $newEnv[$k] = $EnvBlock[$k] }
    }
    foreach ($k in ($RetiredEnvKeys + $StoreOnlyEnvKeys)) { if ($newEnv.Contains($k)) { $newEnv.Remove($k) } }
    $merged['env'] = $newEnv
    return ((ConvertTo-TsJson $merged) + "`n")
  }
  if ($result -eq 'contended') {
    throw "$SettingsPath kept changing while the enrolment was being written - nothing was saved. Re-run setup."
  }
  $fields['helper'] = $Record
  Write-TsDeviceStore $fields $StoreDir
  if ($SessionScoped) {
    try { Add-TsSettingsFile $StoreDir $SettingsPath } catch {
      Write-TsErr "[tokenscope] WARN: could not list $SettingsPath in $StoreDir; a plugin update will not migrate its helper command. Re-run setup after updating."
    }
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $same = ([System.IO.Path]::GetFullPath($IndexDir).TrimEnd($sep)).Equals(([System.IO.Path]::GetFullPath($StoreDir).TrimEnd($sep)), (Get-TsPathComparison))
    if (-not $same) {
      try { Add-TsIsolatedSettingsFile $IndexDir $SettingsPath $StoreDir } catch {
        Write-TsErr "[tokenscope] WARN: could not index $SettingsPath in $IndexDir; a plugin update will not migrate its helper command. Re-run setup after updating."
      }
    }
  }
  return $state.Change
}

# ---- the POST ----------------------------------------------------------------

function Get-TsPluginVersion {
  try {
    $doc = Read-TsJsonFile ([System.IO.Path]::Combine([System.IO.Path]::Combine([System.IO.Path]::Combine($PSScriptRoot, '..'), '.claude-plugin'), 'plugin.json'))
    $v = (Get-TsJsonString $doc 'version').Trim()
    if ($v.Length -le 40 -and $v -cmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$') { return $v }
  } catch { }
  return ''
}

# One POST under ONE deadline for all of it -- connect, headers and body -- of
# $RedeemDeadlineMs (30s), through System.Net.Http.HttpClient on 5.1 and pwsh 7
# alike. Not Invoke-WebRequest: on 5.1 its -TimeoutSec bounds only the wait for
# the response, so a server that sent headers and then trickled the body held
# setup indefinitely (#418; otel-headers-helper.ps1's Invoke-Http does the same).
# No redirects: the handoff code is never re-sent elsewhere. The proxy is the
# system default. Returns @{ Status; Bytes; Error }: Status 0 means no complete
# response inside the deadline, and Error names the failure without its message
# (which can quote the URL).
$RedeemDeadlineMs = 30000
function Invoke-TsHttpPost([string]$Url, [hashtable]$Headers, [byte[]]$Body, [string]$ContentType) {
  Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.Net.Http
  $r = @{ Status = 0; Bytes = $null; Error = 'Timeout' }
  $handler = $null
  $client = $null
  $req = $null
  $resp = $null
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds($RedeemDeadlineMs)
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $Url)
    $req.Headers.ExpectContinue = $false
    # Invoke-WebRequest always sent one, and some WAF rule sets refuse a request without.
    [void]$req.Headers.TryAddWithoutValidation('User-Agent', 'TokenScope-PowerShell/' + $PSVersionTable.PSVersion.Major + '.' + $PSVersionTable.PSVersion.Minor)
    foreach ($k in @($Headers.Keys)) { [void]$req.Headers.TryAddWithoutValidation([string]$k, [string]$Headers[$k]) }
    $req.Content = New-Object System.Net.Http.ByteArrayContent(, $Body)
    $req.Content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue($ContentType)
    $send = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseContentRead)
    if (-not $send.Wait($RedeemDeadlineMs)) { return $r }
    $resp = $send.Result
    $read = $resp.Content.ReadAsByteArrayAsync()
    if (-not $read.Wait([int][Math]::Max(0, $RedeemDeadlineMs - $sw.ElapsedMilliseconds))) { return $r }
    $r.Bytes = $read.Result
    $r.Status = [int]$resp.StatusCode
    $r.Error = ''
  } catch {
    # The innermost exception's type: an AggregateException says nothing.
    $e = $_.Exception
    while ($null -ne $e.InnerException) { $e = $e.InnerException }
    $r = @{ Status = 0; Bytes = $null; Error = $e.GetType().Name }
  } finally {
    # Disposing the client also cancels a request still running past the deadline.
    foreach ($d in @($resp, $req, $client, $handler)) { if ($null -ne $d) { try { $d.Dispose() } catch { } } }
  }
  return $r
}

function Invoke-TsRedeem([string]$Url, [string]$Body) {
  # ADD TLS 1.2 to what is enabled, never assign it: an assignment would switch
  # TLS 1.3 off where the host has it. 5.1 otherwise sends `Expect:
  # 100-continue` on the POST and waits for the server's interim answer.
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
  [System.Net.ServicePointManager]::Expect100Continue = $false
  $headers = @{ 'X-TokenScope-Setup-Mode' = 'emit-only' }
  $pv = Get-TsPluginVersion
  if ($pv) { $headers['X-TokenScope-Plugin-Version'] = $pv }
  $resp = Invoke-TsHttpPost $Url $headers ($Utf8NoBom.GetBytes($Body)) 'application/json'
  if ($resp.Status -eq 0) { throw "request failed ($($resp.Error))" }
  $code = $resp.Status
  if ($code -lt 200 -or $code -gt 299) { throw "HTTP $code" }
  try {
    $text = ConvertFrom-TsUtf8 $resp.Bytes
    return ,(ConvertFrom-TsJson $text)
  } catch {
    throw 'Non-JSON response'
  }
}

# ---- main --------------------------------------------------------------------

function Invoke-TsMain($Argv) {
  $a = Read-TsArgs $Argv
  if (-not $a.HandoffCode) {
    Write-TsErr '[tokenscope] handoff code is required (pass it as the first argument or via --handoff-code)'
    return 1
  }
  $profileRoot = Get-TsProfileRoot
  # #449: the install running this setup (claude-config-dir.ps1): Claude
  # Desktop's own CLAUDE_CONFIG_DIR when the user's environment set it, else
  # <profile>\.claude. Its settings and device store are its own, as
  # claude-redeem.mjs keys them.
  $cfg = Resolve-TsClaudeConfigDir $profileRoot
  $scriptsDir = $PSScriptRoot
  $discovered = Find-TsMcpOrigin $profileRoot $scriptsDir
  $configured = Get-TsConfiguredServerUrl $profileRoot $scriptsDir $cfg.Dir
  $packagedDefault = Get-TsPackagedDefault
  # api-base.mjs knownApiOrigins: what --api-base may SELECT.
  $known = @($packagedDefault, $configured, $discovered)
  $apiBase = Resolve-TsApiBase (Select-TsApiBaseArg $a.ApiBase $known) $configured $discovered $packagedDefault
  $redeemUrl = "$apiBase/api/v1/setup/redeem"
  if (-not $redeemUrl.StartsWith('http')) {
    Write-TsErr '[tokenscope] Cannot resolve redeem URL - the API base needs an http(s):// scheme (check the tokenscope MCP server registered in your client config, or pass --api-base).'
    return 1
  }
  $trustedDir = [System.IO.Path]::Combine($profileRoot, '.tokenscope')
  if (-not $a.SettingsPath -and $cfg.Refused) {
    Write-TsErr "[tokenscope] WARN: CLAUDE_CONFIG_DIR is set but was not used ($($cfg.Refused)); writing $([System.IO.Path]::Combine($cfg.Dir, 'settings.json')) instead."
  }
  $storeDir = $a.StateDir
  if (-not $storeDir) {
    if ($a.SettingsPath) { $storeDir = $trustedDir } else { $storeDir = Get-TsClaudeStateDir $cfg.Dir $profileRoot }
  }
  # The helper command names the store this redeem writes, unless it is the default one.
  $recordDir = $a.StateDir
  if (-not $recordDir -and -not $storeDir.Equals($trustedDir, (Get-TsPathComparison))) { $recordDir = $storeDir }
  # Built and checked BEFORE the handoff is spent: a state dir or install path
  # cmd.exe cannot carry, or a snapshot that cannot be written, is a refusal,
  # not a half-written enrolment.
  $record = New-TsHelperRecord $recordDir
  try {
    $helperScriptsDir = Copy-TsHelperSnapshot $storeDir
  } catch {
    Write-TsErr "[tokenscope] could not copy the emit helper into $storeDir - make the directory writable and re-run setup."
    return 1
  }
  $helperCommand = New-TsHelperCommand $record $helperScriptsDir

  Write-TsOut '[tokenscope] Redeeming handoff...'
  $body = '{"handoff_code":' + (ConvertTo-TsJsonString $a.HandoffCode)
  if ($a.InstanceId) { $body += ',"instance_id":' + (ConvertTo-TsJsonString $a.InstanceId) }
  $body += '}'
  try {
    $resp = Invoke-TsRedeem $redeemUrl $body
  } catch {
    Write-TsErr "[tokenscope] Redeem failed: $($_.Exception.Message)"
    return 1
  }
  try {
    $claude = Assert-TsRedeemResponse $resp
  } catch {
    Write-TsErr "[tokenscope] $($_.Exception.Message)"
    return 1
  }
  $envBlock = New-TsDeviceEnv $claude $resp

  $planted = $env:USERPROFILE
  if (-not $a.SettingsPath -and $planted -and -not ([System.IO.Path]::GetFullPath($planted).TrimEnd('\', '/')).Equals($profileRoot, (Get-TsPathComparison))) {
    Write-TsErr ("[tokenscope] WARN: USERPROFILE ($planted) differs from your account's real profile ($profileRoot). " +
      'Writing the credential to the real profile; Claude Code reads USERPROFILE, so emission may not start until it is corrected.')
  }
  $settingsPath = $a.SettingsPath
  if (-not $settingsPath) { $settingsPath = [System.IO.Path]::Combine($cfg.Dir, 'settings.json') }
  try {
    $change = Write-TsClaudeSettings $settingsPath $helperCommand $record $envBlock $storeDir ([bool]$a.SettingsPath) $trustedDir
  } catch {
    Write-TsErr "[tokenscope] $($_.Exception.Message)"
    return 1
  }

  Write-TsOut ''
  if ($change -and $change.Changed) {
    $from = $change.Old; if (-not $from) { $from = 'previous' }
    $to = $change.New; if (-not $to) { $to = 'new' }
    Write-TsOut "[tokenscope] Environment changed: $from -> $to. Old credentials and endpoints removed."
  }
  Write-TsOut '[tokenscope] OK - Tracking is on for Claude Code on this computer, without Node.js.'
  # Claude Desktop only (desktop-env.mjs): the app replaces the settings-file
  # resource attributes at launch, so this device also goes into the user
  # environment, which the app merges. The CLI path never runs this.
  if (Test-TsTrustedDesktop $settingsPath) {
    $desktopIid = Get-TsJsonString $resp 'instance_id'
    if ($desktopIid -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
      try {
        $merged = Merge-TsDesktopAttrs ([Environment]::GetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES', 'User')) $desktopIid
        if ($null -eq $merged) { throw 'your user OTEL_RESOURCE_ATTRIBUTES is not key=value pairs; left unchanged' }
        [Environment]::SetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES', $merged, 'User')
        Write-TsOut '[tokenscope] OK - Claude Desktop: this device is set in your user environment, so Desktop sessions are attributed.'
        Write-TsOut '[tokenscope]   Next: quit the Claude app completely and open it again. Tracking starts in the new session.'
      } catch {
        Write-TsOut "[tokenscope] WARN: Desktop sessions will not be attributed: could not set your user environment ($($_.Exception.Message))."
      }
    }
  }
  Write-TsOut '[tokenscope]   Next: restart Claude Code. Tracking starts in the new session.'
  Write-TsOut '[tokenscope]   In a repo with a .tokenscope file, restart once more if you see a "superseded device enrolment" warning.'
  Write-TsOut '[tokenscope]   Needs Node.js: the status line, /tokenscope:backfill and repo tagging from a .tokenscope file.'
  Write-TsOut '[tokenscope]   Without Node.js, a plugin update does not update your tracking settings, so run /tokenscope:setup again after each update.'
  Write-TsOut '[tokenscope]   To get everything: winget install OpenJS.NodeJS.LTS, then run /tokenscope:setup again.'
  Write-TsOut "[tokenscope]   Saved to $settingsPath (device $(Get-TsJsonString $resp 'instance_id')); helper copy in $helperScriptsDir."
  return 0
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

# The same merge as desktop-env.mjs mergeDesktopAttrs: keep the user's other
# key=value pairs, replace tokenscope.instance_id and tool with this device's;
# $null when the existing value is not key=value pairs (left alone).
function Merge-TsDesktopAttrs([string]$Existing, [string]$Iid) {
  $kept = @()
  foreach ($seg in ("" + $Existing).Split(',')) {
    $t = $seg.Trim()
    if (-not $t) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -le 0) { return $null }
    $k = $t.Substring(0, $eq).Trim()
    if ($k -ne 'tokenscope.instance_id' -and $k -ne 'tool') { $kept += $t }
  }
  $kept += "tokenscope.instance_id=$($Iid.ToLowerInvariant()),tool=claude-code"
  return ($kept -join ',')
}

# Dot-sourcing (tests) loads the functions without running setup.
if ($MyInvocation.InvocationName -ne '.') {
  try {
    $code = Invoke-TsMain $args
  } catch {
    Write-TsErr "[tokenscope] Fatal: $($_.Exception.Message)"
    $code = 1
  }
  exit $code
}

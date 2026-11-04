# SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/otel-headers-helper.ps1. Re-generate with: npm run sync:copilot-plugin
# otelHeadersHelper for Windows -- the PowerShell twin of otel-headers-helper.sh.
# Claude Code runs it every ~29 minutes (through cmd.exe) to refresh the Azure
# Monitor Bearer for OTLP emission, as:
#
#   "<abs>\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass
#     -File "<abs>\otel-headers-helper.ps1" --tool <tool> [--state-dir <abs>]
#
# Contract (same as the .sh): on success print ONE line of compact JSON holding
# the Authorization header to stdout and exit 0. On failure print nothing to
# stdout, write the failure sentinel, say why on stderr, and exit non-zero.
#
# SAME FILES, SAME SHAPES as the .sh, so a device can switch between the two
# helpers without re-enrolling: config.<tool>.json (read), oauth-access.<tool>.json,
# azure-bearer.<tool>.json, emit-degraded.<tool>.json, emit-failure.<tool>.json.
# The guarantee list is issue #408 Appendix A plus the #409 cached-bearer rules;
# the .sh header comments carry the reasoning for each and are not repeated here.
#
# WRITTEN TO WINDOWS POWERSHELL 5.1. No `??`, no ternary, no -AsHashtable, no
# -SkipHttpErrorCheck, no Join-Path -AdditionalChildPath. It also runs under
# pwsh 7 on Linux/macOS, which is how the conformance suite drives it
# (tests/unit/plugin/otel-helper-conformance.test.ts). This file must stay
# ASCII: 5.1 reads a BOM-less script as the ANSI code page.
#
# Deliberate differences from the .sh (#408 Appendix A section 11):
#   - JSON is parsed (ConvertFrom-Json) and only NAMED TOP-LEVEL fields are read
#     (env.<KEY> for settings.json). The .sh greps the whole file, last match
#     anywhere, escapes undecoded. Duplicate keys: last wins on both runtimes.
#     Comments/trailing commas in settings.json: pwsh 7 accepts them, 5.1 does
#     not; a settings file 5.1 cannot parse is "trusted but unusable", never a
#     reason to take endpoints from the environment.
#   - v2 per-tool store only. The legacy shared config.json is not read: no
#     Windows device ever had it.
#   - A loopback http endpoint must also PARSE as loopback ([Uri].IsLoopback), so
#     `http://127.0.0.1:1@evil.example/` is refused; the .sh's prefix match lets
#     curl decide.
#   - A 200 from /bearer whose body has no Authorization string is a failure; the
#     .sh prints the body as-is.
#   - Sentinel http_status is 0 for "no HTTP response" (the .sh writes 000).
#   - No profile at all (GetFolderPath returns empty) and no --state-dir: exit 1.
#     The .sh falls back to $HOME with a warning; there is no safe equivalent.

# -- BEFORE THE FIRST CMDLET ---------------------------------------------------
#
# PSModulePath is the PowerShell PATH: the first cmdlet used (Add-Type,
# ConvertFrom-Json) autoloads its module by searching it, and Claude
# Code hands this process the repo-merged settings environment. Left alone, a
# repository chooses the code that parses the credential and loads the HTTP
# stack the refresh token is handed to. The
# engine's own module directory ($PSHOME, not an environment variable) is the
# only entry kept. String concatenation, not Join-Path: Join-Path is a cmdlet.
$env:PSModulePath = $PSHOME + [IO.Path]::DirectorySeparatorChar + 'Modules'
# PATH next, for the same reason (otel-headers-helper.sh pins TRUSTED_PATH):
# nothing here runs a program by name, and nothing added later may find one
# the repository put on PATH. Windows only; off Windows only tests run this.
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $env:PATH = [Environment]::SystemDirectory + ';' + [Environment]::SystemDirectory + '\WindowsPowerShell\v1.0' }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# 5.1 draws a progress bar for every web request: slow, and host noise.
$ProgressPreference = 'SilentlyContinue'
# 5.1 negotiates TLS 1.0 by default against some hosts; Azure Front Door and the
# token endpoint require 1.2. ADD 1.2 to whatever is enabled rather than
# assigning it: an assignment would switch TLS 1.3 off on hosts that have it.
# Harmless under pwsh 7 (HttpClient ignores it).
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# 5.1 otherwise sends `Expect: 100-continue` on the refresh POST and stalls.
[Net.ServicePointManager]::Expect100Continue = $false

$IsWin = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
$UnixFileMode = 'System.IO.UnixFileMode' -as [type]

function Write-Err([string]$Message) { [Console]::Error.WriteLine($Message) }

# -- ARGUMENTS ONLY (Appendix A section 1) ---------------------------------------
#
# The state dir decides where an access token is cached, so it never comes from
# the environment (a repo can set TOKENSCOPE_STATE_DIR, USERPROFILE and HOME).
# argv is the one channel a settings merge cannot contribute to. `--tool-dir`
# is a .sh test seam with no meaning here (no subprocesses) and is refused like
# any other unknown argument.
function Test-AbsolutePath([string]$p) {
  if ([string]::IsNullOrEmpty($p)) { return $false }
  if ($IsWin) {
    # Fully qualified only: `\x` and `C:x` are rooted but relative to a drive or
    # a per-drive cwd, which for a Claude Code helper is the repository.
    return ($p -match '^[A-Za-z]:[\\/]' -or $p -match '^\\\\[^\\/]')
  }
  return $p.StartsWith('/', [StringComparison]::Ordinal)
}

$StateDir = ''
$Tool = 'claude-code'
$i = 0
while ($i -lt $args.Count) {
  $a = [string]$args[$i]
  if ($a -ceq '--state-dir' -or $a -ceq '--tool') {
    if ($i + 1 -ge $args.Count) { Write-Err "otel-headers-helper: $a requires a value"; exit 2 }
    $v = [string]$args[$i + 1]
    if ($a -ceq '--state-dir') {
      if (-not (Test-AbsolutePath $v)) { Write-Err 'otel-headers-helper: --state-dir must be a non-empty absolute path'; exit 2 }
      $StateDir = $v
    } else {
      if ($v -cne 'claude-code' -and $v -cne 'copilot-cli') { Write-Err 'otel-headers-helper: --tool must be claude-code or copilot-cli'; exit 2 }
      $Tool = $v
    }
    $i += 2
    continue
  }
  Write-Err 'otel-headers-helper: unknown argument'
  exit 2
}

# The profile comes from the OS (SHGetKnownFolderPath on Windows), never from
# $env:USERPROFILE or $env:HOME, which a repository can set. The sh mirror of
# this is passwd_home(). On Linux/macOS .NET answers from $HOME first: only the
# test harness runs it there.
$ProfileDir = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrEmpty($StateDir)) {
  if ([string]::IsNullOrEmpty($ProfileDir)) {
    Write-Err 'TokenScope: emission auth FAILED (this account has no profile directory; pass --state-dir) - telemetry is being DROPPED.'
    exit 1
  }
  $StateDir = [IO.Path]::Combine($ProfileDir, '.tokenscope')
}

$Sentinel = [IO.Path]::Combine($StateDir, "emit-failure.$Tool.json")
$Store = [IO.Path]::Combine($StateDir, "config.$Tool.json")
$AccessCache = [IO.Path]::Combine($StateDir, "oauth-access.$Tool.json")
$AzureCache = [IO.Path]::Combine($StateDir, "azure-bearer.$Tool.json")
$Degraded = [IO.Path]::Combine($StateDir, "emit-degraded.$Tool.json")
$ExpirySkew = 120

# -- JSON: read named fields, write by hand -------------------------------------

# A field of a parsed JSON object, matched case-SENSITIVELY (PowerShell property
# lookup is not; JSON keys are). $null when absent or $Obj is not an object.
function Get-JsonProp($Obj, [string]$Name) {
  if ($null -eq $Obj -or -not ($Obj -is [System.Management.Automation.PSCustomObject])) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p -or $p.Name -cne $Name) { return $null }
  return $p.Value
}
function Get-JsonStr($Obj, [string]$Name) {
  $v = Get-JsonProp $Obj $Name
  if ($v -is [string]) { return $v }
  return ''
}
# A non-negative whole number, else $null. Matches the .sh json_num, which only
# ever reads digits.
function Get-JsonInt($Obj, [string]$Name) {
  $v = Get-JsonProp $Obj $Name
  if ($v -is [int] -or $v -is [long]) { if ($v -ge 0) { return [long]$v } ; return $null }
  if ($v -is [double] -or $v -is [decimal]) { if ($v -ge 0) { return [long][Math]::Floor($v) } ; return $null }
  return $null
}
# Parse text as a JSON object; $null for anything else (unparseable, array,
# scalar, empty). Never throws.
function ConvertFrom-JsonObject([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  try { $o = ConvertFrom-Json -InputObject $Text } catch { return $null }
  if ($o -is [System.Management.Automation.PSCustomObject]) { return $o }
  return $null
}
function Read-JsonFile([string]$Path) {
  try { $t = [IO.File]::ReadAllText($Path) } catch { return $null }
  return ConvertFrom-JsonObject $t
}
# A JSON string literal. Everything outside printable ASCII is \u-escaped, so
# every byte this helper writes (stdout and files) is ASCII: no BOM question,
# no code-page question on 5.1.
function ConvertTo-JsonString([string]$s) {
  $sb = New-Object Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if ($c -eq 34) { [void]$sb.Append('\"') }
    elseif ($c -eq 92) { [void]$sb.Append('\\') }
    elseif ($c -lt 32 -or $c -gt 126) { [void]$sb.Append(('\u{0:x4}' -f $c)) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}
# The .sh strips these before using a value as a cache key or a JSON string:
# control characters, quote, backslash.
function Remove-Unbindable([string]$s) { return ($s -replace '[\x00-\x1f"\\]', '') }

function Get-UtcStamp { return [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture) }
function Get-NowEpoch { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

# -- FILES ----------------------------------------------------------------------

function Initialize-StateDir {
  if ([IO.Directory]::Exists($StateDir)) { return }
  try {
    [void][IO.Directory]::CreateDirectory($StateDir)
    # Windows: the profile ACL is the boundary (device-store trust doc). Elsewhere
    # (the test harness) 0700, as the .sh's umask gives.
    if (-not $IsWin -and $null -ne $UnixFileMode) {
      [IO.File]::SetUnixFileMode($StateDir, [Enum]::Parse($UnixFileMode, 'UserRead, UserWrite, UserExecute'))
    }
  } catch { }
}

function Remove-QuietFile([string]$Path) {
  try { if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) } } catch { }
}

# Atomically replace $Path with $Content + LF. A RANDOM temp name in the same
# directory (process ids collide across containers sharing a home), written
# UTF-8 without BOM, then File.Replace over an existing target (one atomic
# ReplaceFile on Windows; Move-Item -Force deletes then moves, leaving a window
# with no file) or File.Move onto a new one, retried briefly because Windows
# refuses to replace a file another process (an editor, antivirus, a
# concurrent session) has open. The temp never survives. Returns $false only
# when no temp file could be created; a failed write or move is best effort.
function Write-PrivateJson([string]$Path, [string]$Content) {
  Initialize-StateDir
  $tmp = $Path + '.tmp.' + ([IO.Path]::GetRandomFileName() -replace '\.', '')
  try {
    $fs = New-Object IO.FileStream($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $fs.Dispose()
  } catch { return $false }
  try {
    if (-not $IsWin -and $null -ne $UnixFileMode) {
      [IO.File]::SetUnixFileMode($tmp, [Enum]::Parse($UnixFileMode, 'UserRead, UserWrite'))
    }
    [IO.File]::WriteAllText($tmp, $Content + "`n", (New-Object Text.UTF8Encoding $false))
    for ($n = 0; $n -lt 5; $n++) {
      try {
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) }
        else { [IO.File]::Move($tmp, $Path) }
        break
      } catch { Start-Sleep -Milliseconds 50 }
    }
  } catch { }
  finally { Remove-QuietFile $tmp }
  return $true
}

function Clear-Sentinel { Remove-QuietFile $Sentinel }
function Clear-Degraded { Remove-QuietFile $Degraded }
function Remove-AzureCache { Remove-QuietFile $AzureCache }

# The failure sentinel: {ts, http_status, message}. The message loses quotes,
# backslashes and control characters and is cut to 300 characters. Token
# material is never passed in.
function Write-Sentinel([int]$Status, [string]$Message) {
  $m = Remove-Unbindable $Message
  if ($m.Length -gt 300) { $m = $m.Substring(0, 300) }
  [void](Write-PrivateJson $Sentinel ('{"ts":' + (ConvertTo-JsonString (Get-UtcStamp)) + ',"http_status":' + $Status + ',"message":' + (ConvertTo-JsonString $m) + '}'))
}

# The only stdout this helper ever produces: one line, compact, ASCII, LF.
function Write-HeaderAndExit([string]$Json) {
  [Console]::Out.Write($Json + "`n")
  [Console]::Out.Flush()
  exit 0
}

# -- CACHED AZURE BEARER (#409) -------------------------------------------------
# TokenScope UNREACHABLE (network, timeout, 408/429/5xx) -> hand back the bearer
# /bearer last returned for THIS endpoint and let Azure judge it. Never after an
# auth verdict this run; a verdict deletes it. The stored expiry is diagnostics:
# a known-expired cache is still handed back, but the sentinel is written so the
# health readers go red. Reasoning: the .sh, AZURE_CACHE.
$VerdictSeen = $false

function Write-AzureCache([string]$Authorization, $ExpiresAt) {
  $auth = Remove-Unbindable $Authorization
  if ([string]::IsNullOrEmpty($auth)) { return }
  $exp = 0
  if ($ExpiresAt -match '^[0-9]{1,18}$') { $exp = [long]$ExpiresAt }
  if ((Remove-Unbindable $script:BearerEp) -cne $script:BearerEp) { return }
  [void](Write-PrivateJson $AzureCache ('{"authorization":' + (ConvertTo-JsonString $auth) + ',"expires_at":' + $exp + ',"bearer_endpoint":' + (ConvertTo-JsonString $script:BearerEp) + '}'))
}

# Exits 0 with the cached bearer, or returns and the caller fails.
function Use-CachedBearer([string]$Reason) {
  if ($script:VerdictSeen) { return }
  if (-not [IO.File]::Exists($AzureCache)) { return }
  $c = Read-JsonFile $AzureCache
  if ($null -eq $c) { return }
  $ep = $script:BearerEp
  if ([string]::IsNullOrEmpty($ep) -or (Remove-Unbindable $ep) -cne $ep) { return }
  if ((Get-JsonStr $c 'bearer_endpoint') -cne $ep) { return }
  $auth = Get-JsonStr $c 'authorization'
  if ([string]::IsNullOrEmpty($auth)) { return }
  $exp = Get-JsonInt $c 'expires_at'
  if ($null -eq $exp) { $exp = 0 }
  $expired = ($exp -gt 0 -and $exp -le (Get-NowEpoch))
  if ($expired) { $note = "cached bearer EXPIRED at $exp; Azure will refuse it until TokenScope is reachable again" }
  elseif ($exp -gt 0) { $note = "cached bearer valid until $exp" }
  else { $note = 'cached bearer expiry unknown' }
  Write-Err "TokenScope: emission auth DEGRADED ($Reason) - emitting on the cached Azure bearer ($note). Run /tokenscope:status if this persists."
  $r = Remove-Unbindable $Reason
  if ($r.Length -gt 200) { $r = $r.Substring(0, 200) }
  [void](Write-PrivateJson $Degraded ('{"ts":' + (ConvertTo-JsonString (Get-UtcStamp)) + ',"reason":' + (ConvertTo-JsonString $r) + ',"expires_at":' + $exp + '}'))
  if ($expired) {
    Write-Sentinel 0 "TokenScope unreachable ($r); cached Azure bearer expired at $exp - exports are probably being refused"
  } else {
    Clear-Sentinel
  }
  Write-HeaderAndExit ('{"Authorization":' + (ConvertTo-JsonString $auth) + '}')
}

# -- WHERE THE CREDENTIAL AND DESTINATIONS COME FROM (Appendix A section 4) --------
#
# One ordered list; a credential from a trusted source is NEVER paired with a
# destination from a less trusted one. Absent -> next source; present but
# incomplete -> refuse; present and complete -> adopted whole.
#   1. $Store                                this lane's own v2 store
#   2. <profile>\.claude\settings.json env   a repo can add to the environment,
#                                            not edit this file
#   3. the process environment               repo-influenced; last resort
$RefreshToken = ''
$BearerEp = ''
$TokenEp = ''
$ClientId = ''
$Resolved = $false
$TrustedSeenUnusable = $false
$UnusableWhy = ''

function Invoke-Refuse([string]$SentinelMessage, [string]$Explanation) {
  Write-Err "TokenScope: emission auth REFUSED - $Explanation Telemetry will not emit."
  Clear-Degraded
  Write-Sentinel 0 $SentinelMessage
  exit 1
}

function Set-Source([string]$Token, [string]$Bearer, [string]$TokEp, [string]$Cid) {
  $script:RefreshToken = $Token
  $script:BearerEp = $Bearer
  $script:TokenEp = $TokEp
  if (-not [string]::IsNullOrEmpty($Cid)) { $script:ClientId = $Cid }
  $script:Resolved = $true
}

# The first `key=` value in an OTEL_RESOURCE_ATTRIBUTES string.
function Get-AttrValue([string]$Attrs, [string]$Key) {
  foreach ($part in $Attrs.Split(',')) {
    $t = $part.TrimStart()
    if ($t.StartsWith($Key + '=', [StringComparison]::Ordinal)) { return $t.Substring($Key.Length + 1) }
  }
  return ''
}
# The instance segment of .../instances/<id>/bearer, END-ANCHORED, no query or
# fragment before it, last segment wins (greedy) -- as device-store.mjs and the .sh.
function Get-BearerInstance([string]$Url) {
  $m = [regex]::Match($Url, '^[^?#]*/instances/([^/?#]+)/bearer\z')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

# Everything from here runs inside one try: an unexpected exception becomes a
# sentinel and exit 1, never a PowerShell error record quoting paths or URLs.
try {

# -- source 1: this lane's own store --
if ([IO.File]::Exists($Store)) {
  $cfg = Read-JsonFile $Store
  $sTool = Get-JsonStr $cfg 'tool'
  $sInst = Get-JsonStr $cfg 'instance_id'
  $sBear = Get-JsonStr $cfg 'bearer_endpoint'
  $sTokEp = Get-JsonStr $cfg 'oauth_token_endpoint'
  $sTok = Get-JsonStr $cfg 'oauth_refresh_token'
  $sCid = Get-JsonStr $cfg 'oauth_client_id'
  $sAttr = Get-JsonStr $cfg 'otel_resource_attributes'
  $sVer = Get-JsonInt $cfg 'version'

  if ($sTool -ne '' -and $sTool -cne $Tool) {
    Invoke-Refuse 'store tool mismatch' "$Store declares tool=$sTool but this is the $Tool lane. The file was renamed or copied; re-run setup."
  }
  $sAttrTool = Get-AttrValue $sAttr 'tool'
  if ($sAttrTool -ne '' -and $sAttrTool -cne $Tool) {
    Invoke-Refuse 'store marker mismatch' "$Store carries tool=$sAttrTool in its resource attributes but this is the $Tool lane. Re-run setup."
  }
  if ($sTok -eq '' -or $sBear -eq '' -or $sTokEp -eq '') {
    Invoke-Refuse 'store present but unreadable' "$Store exists but is not a complete v2 enrolment (credential plus both destinations), and the session environment is not an acceptable substitute. Re-run the tokenscope-setup MCP prompt."
  }
  if ($null -eq $sVer -or $sVer -ne 2 -or $sTool -eq '' -or $sInst -eq '' -or $sAttr -eq '') {
    Invoke-Refuse 'store missing the v2 envelope' "$Store is not a v2 enrolment (version/tool/instance_id/resource attributes), so this lane cannot confirm it belongs here. Re-run the tokenscope-setup MCP prompt."
  }
  $sAttrInst = Get-AttrValue $sAttr 'tokenscope.instance_id'
  if ($sAttrTool -eq '' -or $sAttrInst -eq '' -or $sAttrInst -cne $sInst) {
    Invoke-Refuse 'store attributes inconsistent' "$Store resource attributes do not name this file's instance and tool. Re-run the tokenscope-setup MCP prompt."
  }
  $sBearInst = Get-BearerInstance $sBear
  if ($sBearInst -eq '' -or $sBearInst -cne $sInst) {
    Invoke-Refuse 'store instance/endpoint mismatch' "$Store names instance $sInst but its bearer endpoint addresses '$sBearInst'. Re-run setup."
  }
  Set-Source $sTok $sBear $sTokEp $sCid
}

# -- source 2: the device's own settings file (env block only) --
if (-not $Resolved -and -not [string]::IsNullOrEmpty($ProfileDir)) {
  $gsFile = [IO.Path]::Combine($ProfileDir, '.claude', 'settings.json')
  if ([IO.File]::Exists($gsFile)) {
    $gsText = ''
    try { $gsText = [IO.File]::ReadAllText($gsFile) } catch { $gsText = '' }
    $gs = ConvertFrom-JsonObject $gsText
    $gsEnv = Get-JsonProp $gs 'env'
    $gsTok = Get-JsonStr $gsEnv 'TOKENSCOPE_OAUTH_REFRESH_TOKEN'
    if ($gsTok -eq '') {
      # Present but unusable is not absent: Claude Code may already have merged
      # this file's token into the environment. "No credential here" holds only
      # for a parsed settings object with an env block that never names the key.
      if (-not ($gsEnv -is [System.Management.Automation.PSCustomObject]) -or $gsText.Contains('TOKENSCOPE_OAUTH_REFRESH_TOKEN')) {
        $TrustedSeenUnusable = $true
        # Named in the refusal below (#452), as the .sh does.
        if ($gsText.Contains('TOKENSCOPE_OAUTH_REFRESH_TOKEN')) {
          $UnusableWhy += " $gsFile mentions a TokenScope credential that could not be read."
        } else {
          $UnusableWhy += " $gsFile could not be read as a settings file."
        }
      }
    } else {
      $gsBear = Get-JsonStr $gsEnv 'TOKENSCOPE_BEARER_ENDPOINT'
      $gsTokEp = Get-JsonStr $gsEnv 'TOKENSCOPE_OAUTH_TOKEN_ENDPOINT'
      if ($gsBear -eq '' -or $gsTokEp -eq '') {
        Invoke-Refuse 'settings credential without both settings endpoints' "$gsFile holds a durable credential but not both destinations, so one would come from the session environment. Re-run the tokenscope-setup MCP prompt."
      }
      Set-Source $gsTok $gsBear $gsTokEp (Get-JsonStr $gsEnv 'TOKENSCOPE_OAUTH_CLIENT_ID')
    }
  }
}

$envTok = [string]$env:TOKENSCOPE_OAUTH_REFRESH_TOKEN
if (-not $Resolved -and $TrustedSeenUnusable -and $envTok -ne '') {
  Invoke-Refuse 'trusted source unusable, ambient credential present' "this device has a stored enrolment this lane cannot use, and the session environment is not an acceptable substitute while a durable credential is reachable. This lane's device store $Store is missing.$UnusableWhy Re-run the tokenscope-setup MCP prompt."
}

# -- source 3: the process environment --
if (-not $Resolved) {
  $RefreshToken = $envTok
  $BearerEp = [string]$env:TOKENSCOPE_BEARER_ENDPOINT
  $TokenEp = [string]$env:TOKENSCOPE_OAUTH_TOKEN_ENDPOINT
}
# An identifier, not a credential or a destination: may come from here regardless.
if ($ClientId -eq '') { $ClientId = [string]$env:TOKENSCOPE_OAUTH_CLIENT_ID }

# -- ENDPOINT GUARD (Appendix A section 5) ---------------------------------------
# https, or http to loopback. Case-SENSITIVE prefixes like the .sh's `case`; the
# loopback host must also parse as loopback so userinfo cannot smuggle a host.
function Assert-SafeEndpoint([string]$Ep, [string]$Label) {
  if ($Ep -eq '') {
    Write-Err "TokenScope: emission auth FAILED ($Label is empty) - telemetry is being DROPPED."
    Write-Sentinel 0 "$Label is empty"
    exit 1
  }
  if ($Ep.StartsWith('-', [StringComparison]::Ordinal)) {
    Write-Err "TokenScope: emission auth FAILED ($Label must not start with '-') - telemetry is being DROPPED."
    Write-Sentinel 0 "$Label starts with '-'"
    exit 1
  }
  $uri = $null
  $ok = [Uri]::TryCreate($Ep, [UriKind]::Absolute, [ref]$uri)
  if ($ok -and $Ep.StartsWith('https://', [StringComparison]::Ordinal) -and $uri.Scheme -ceq 'https') { return }
  if ($ok -and $uri.Scheme -ceq 'http' -and $uri.IsLoopback -and $uri.UserInfo -eq '' -and
      ($Ep -cmatch '^http://(127\.0\.0\.1|localhost|\[::1\])([:/]|\z)')) { return }
  Write-Err "TokenScope: emission auth FAILED ($Label must be https for an off-box host) - telemetry is being DROPPED."
  Write-Sentinel 0 "$Label must be https off-box"
  exit 1
}

# -- HTTP ------------------------------------------------------------------------
# One request, under ONE deadline for all of it -- connect, headers and body --
# of $HttpDeadlineMs (the .sh's curl --max-time 10). System.Net.Http.HttpClient
# on 5.1 and pwsh 7 alike, so the path the conformance suite drives under pwsh 7
# is the path Windows runs. Not Invoke-WebRequest: on 5.1 its -TimeoutSec bounds
# only the wait for the response, so a server that sent headers and then
# trickled the body held the helper until Claude Code killed it at 30s, before
# the cached-bearer fallback could run (#418). HttpClient.Timeout with
# ResponseContentRead (which buffers the body inside SendAsync) bounds the whole
# request: conformance K18/K19 prove it against a trickled body. The Wait below,
# on the same budget, is an extra guard that no test exercises on its own.
# No redirects: a 3xx is a failure with its own status, and the refresh body is
# never re-sent elsewhere. The proxy is the system default, as Invoke-WebRequest's.
# Returns @{Status; Body; Headers}. Status 0: no complete response inside the
# deadline, or none at all (unreachable). Any response, 4xx/5xx included, carries
# its status and body. Headers: a case-insensitive hashtable, name -> values.
$HttpDeadlineMs = 10000
function Invoke-Http([string]$Method, [string]$Uri, [hashtable]$Headers, [string]$Body) {
  # Outside the try: an HttpClient that cannot load is an internal error, never
  # an unreachable server (which would hand back the cached bearer).
  Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.Net.Http
  $r = @{ Status = 0; Body = ''; Headers = $null }
  $handler = $null
  $client = $null
  $req = $null
  $resp = $null
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds($HttpDeadlineMs)
    $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method)), $Uri)
    $req.Headers.ExpectContinue = $false
    # Invoke-WebRequest always sent one, and some WAF rule sets refuse a request without.
    [void]$req.Headers.TryAddWithoutValidation('User-Agent', 'TokenScope-PowerShell/' + $PSVersionTable.PSVersion.Major + '.' + $PSVersionTable.PSVersion.Minor)
    foreach ($k in @($Headers.Keys)) { [void]$req.Headers.TryAddWithoutValidation([string]$k, [string]$Headers[$k]) }
    if ($Method -eq 'POST') {
      $req.Content = New-Object System.Net.Http.ByteArrayContent(, [Text.Encoding]::UTF8.GetBytes($Body))
      $req.Content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/x-www-form-urlencoded')
    }
    $send = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseContentRead)
    if (-not $send.Wait($HttpDeadlineMs)) { return $r }
    $resp = $send.Result
    $read = $resp.Content.ReadAsByteArrayAsync()
    if (-not $read.Wait([int][Math]::Max(0, $HttpDeadlineMs - $sw.ElapsedMilliseconds))) { return $r }
    $hs = @{}
    foreach ($h in @($resp.Headers) + @($resp.Content.Headers)) { $hs[[string]$h.Key] = @($h.Value) }
    $r.Body = [Text.Encoding]::UTF8.GetString($read.Result)
    $r.Headers = $hs
    $r.Status = [int]$resp.StatusCode
  } catch {
    # Timeout, refused connection, DNS, TLS: no HTTP response.
    $r = @{ Status = 0; Body = ''; Headers = $null }
  } finally {
    # Disposing the client also cancels a request still running past the deadline.
    foreach ($d in @($resp, $req, $client, $handler)) { if ($null -ne $d) { try { $d.Dispose() } catch { } } }
  }
  return $r
}
# The last value of a response header, case-insensitively.
function Get-ResponseHeader($Headers, [string]$Name) {
  if ($null -eq $Headers) { return '' }
  $val = ''
  foreach ($k in @($Headers.Keys)) {
    if ([string]$k -ieq $Name) { $v = $Headers[$k]; $val = [string](@($v)[-1]) }
  }
  return $val
}
function Test-Transient([int]$s) { return ($s -eq 0 -or $s -eq 408 -or $s -eq 429 -or ($s -ge 500 -and $s -le 599)) }
function Format-Status([int]$s) { if ($s -eq 0) { return '000' } ; return [string]$s }

# -- OAuth refresh_token grant (Appendix A section 7) ------------------------------
# The refresh token rides in the request BODY, never on a command line. On
# failure: transient -> cached Azure bearer if any; verdict -> drop it. Then fail.
$AuthToken = ''
function Invoke-OAuthRefresh {
  $now = Get-NowEpoch
  $form = 'grant_type=refresh_token&client_id=' + [Uri]::EscapeDataString($script:ClientId) + '&refresh_token=' + [Uri]::EscapeDataString($script:RefreshToken)
  $resp = Invoke-Http 'POST' $script:TokenEp @{} $form
  $st = $resp.Status
  $tb = ConvertFrom-JsonObject $resp.Body
  if ($st -ne 200) {
    $err = Get-JsonStr $tb 'error'
    if ($err -eq '') { $err = 'token refresh failed' }
    if (Test-Transient $st) {
      Use-CachedBearer ('OAuth token endpoint HTTP ' + (Format-Status $st))
    } else {
      Remove-AzureCache
      Clear-Degraded
    }
    Write-Err ('TokenScope: emission auth FAILED (OAuth refresh HTTP ' + (Format-Status $st) + " $err) - telemetry is being DROPPED. The durable credential may have lapsed; re-provision emit via the tokenscope-setup MCP prompt or run /tokenscope:status.")
    Write-Sentinel $st "oauth refresh failed: $err"
    exit 1
  }
  $access = Get-JsonStr $tb 'access_token'
  $expiresIn = Get-JsonInt $tb 'expires_in'
  if ($null -eq $expiresIn) { $expiresIn = 0 }
  if ($access -eq '') {
    Write-Err 'TokenScope: emission auth FAILED (OAuth refresh returned no access_token) - telemetry is being DROPPED. Run /tokenscope:status.'
    Write-Sentinel $st 'oauth refresh returned no access_token'
    exit 1
  }
  # Bound to the bearer endpoint it was minted for. No temp file -> fail loudly:
  # skipping the cache means a refresh every run, and two concurrent refreshes
  # invalidate each other server-side.
  $cacheBear = $script:BearerEp
  if ((Remove-Unbindable $cacheBear) -cne $cacheBear) { $cacheBear = '' }
  $ok = Write-PrivateJson $AccessCache ('{"access_token":' + (ConvertTo-JsonString $access) + ',"expires_at":' + ($now + $expiresIn) + ',"bearer_endpoint":' + (ConvertTo-JsonString $cacheBear) + '}')
  if (-not $ok) {
    Write-Err "TokenScope: emission auth FAILED (cannot create a temp file under $StateDir; directory unwritable) - telemetry is being DROPPED."
    Write-Sentinel 0 'cannot create access cache temp'
    exit 1
  }
  $script:AuthToken = $access
}

# -- Client version reporting (Appendix A section 8) --------------------------------
# Diagnostic hints only; a value we cannot determine is OMITTED. Plugin version
# from the manifest beside THIS script (Claude layout, then Copilot layout);
# CLI version from CLAUDE_CODE_EXECPATH's versions/X.Y.Z, else AI_AGENT.
function Get-SafeVersion([string]$v) {
  $v = $v -replace '[\x00-\x1f]', ''
  if ($v -cmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}\z') { return $v }
  return ''
}
$PluginVersion = ''
foreach ($rel in @('..\.claude-plugin\plugin.json', '..\plugin.json')) {
  $mf = [IO.Path]::Combine($PSScriptRoot, ($rel -replace '\\', [string][IO.Path]::DirectorySeparatorChar))
  if ([IO.File]::Exists($mf)) {
    $PluginVersion = Get-JsonStr (Read-JsonFile $mf) 'version'
    if ($PluginVersion -ne '') { break }
  }
}
$CliVersion = ''
$execPath = ([string]$env:CLAUDE_CODE_EXECPATH) -replace '\\', '/'
$m = [regex]::Match($execPath, '.*versions/([0-9]+\.[0-9]+\.[0-9]+)')
if ($m.Success) { $CliVersion = $m.Groups[1].Value }
if ($CliVersion -eq '') {
  $m = [regex]::Match([string]$env:AI_AGENT, '.*claude-code_([0-9]+)-([0-9]+)-([0-9]+)')
  if ($m.Success) { $CliVersion = $m.Groups[1].Value + '.' + $m.Groups[2].Value + '.' + $m.Groups[3].Value }
}

# Platform as `<os>-<arch>` in Node's process.platform/process.arch vocabulary,
# the same strings the .sh reports for the same machine; unrecognised -> omitted.
# Windows: PROCESSOR_ARCHITECTURE (a 32-bit PowerShell sees x86 and omits).
# Elsewhere (pwsh only): RuntimeInformation, which 5.1 never reaches.
$ClientPlatform = ''
$cpArch = ''
if ($IsWin) {
  $pa = [string]$env:PROCESSOR_ARCHITECTURE
  if ($pa -ceq 'AMD64') { $cpArch = 'x64' } elseif ($pa -ceq 'ARM64') { $cpArch = 'arm64' }
  if ($cpArch -ne '') { $ClientPlatform = 'win32-' + $cpArch }
} else {
  $ri = 'System.Runtime.InteropServices.RuntimeInformation' -as [type]
  $osp = 'System.Runtime.InteropServices.OSPlatform' -as [type]
  if ($null -ne $ri -and $null -ne $osp) {
    $cpOs = ''
    if ($ri::IsOSPlatform($osp::Linux)) { $cpOs = 'linux' } elseif ($ri::IsOSPlatform($osp::OSX)) { $cpOs = 'darwin' }
    $arch = [string]$ri::OSArchitecture
    if ($arch -ceq 'X64') { $cpArch = 'x64' } elseif ($arch -ceq 'Arm64') { $cpArch = 'arm64' }
    if ($cpOs -ne '' -and $cpArch -ne '') { $ClientPlatform = $cpOs + '-' + $cpArch }
  }
}
# Which launcher this CLI runs under. claude-code: CLAUDE_CODE_ENTRYPOINT as-is.
# copilot-cli: `app` for the App agent, `cli` for any other github_copilot*
# agent, and NOTHING when AI_AGENT is absent or foreign (a default would flip
# the stored reading on every forwarder mint, which runs without it).
$ClientSurface = ''
if ($Tool -ceq 'copilot-cli') {
  $agent = [string]$env:AI_AGENT
  if ($agent -ceq 'github_copilot_app_agent') { $ClientSurface = 'app' }
  elseif ($agent.StartsWith('github_copilot', [StringComparison]::Ordinal)) { $ClientSurface = 'cli' }
} else {
  $ClientSurface = [string]$env:CLAUDE_CODE_ENTRYPOINT
}
$PluginVersion = Get-SafeVersion $PluginVersion
$CliVersion = Get-SafeVersion $CliVersion
$ClientPlatform = Get-SafeVersion $ClientPlatform
$ClientSurface = Get-SafeVersion $ClientSurface

function Invoke-Bearer {
  $h = @{ Authorization = 'Bearer ' + $script:AuthToken }
  if ($PluginVersion -ne '') { $h['X-TokenScope-Plugin-Version'] = $PluginVersion }
  if ($CliVersion -ne '') { $h['X-TokenScope-Client-Version'] = $CliVersion }
  if ($ClientPlatform -ne '') { $h['X-TokenScope-Client-Platform'] = $ClientPlatform }
  if ($ClientSurface -ne '') { $h['X-TokenScope-Client-Surface'] = $ClientSurface }
  return Invoke-Http 'GET' $script:BearerEp $h $null
}

# -- MAIN -------------------------------------------------------------------------
  if ($BearerEp -eq '') {
    Write-Err 'TokenScope: emission auth NOT CONFIGURED - TOKENSCOPE_BEARER_ENDPOINT not set (connect + provision emit via the tokenscope-setup MCP prompt first). Telemetry will not emit.'
    Clear-Degraded
    Write-Sentinel 0 'TOKENSCOPE_BEARER_ENDPOINT not set'
    exit 1
  }
  Assert-SafeEndpoint $BearerEp 'TOKENSCOPE_BEARER_ENDPOINT'
  # Bindable, or refuse now -- BEFORE any refresh: an endpoint the cache cannot
  # key on would refresh on every run forever.
  if ((Remove-Unbindable $BearerEp) -cne $BearerEp) {
    Write-Err 'TokenScope: emission auth FAILED (TOKENSCOPE_BEARER_ENDPOINT contains a quote, backslash or control character) - telemetry is being DROPPED. Re-run the tokenscope-setup MCP prompt.'
    Write-Sentinel 0 'bearer endpoint not bindable'
    exit 1
  }
  if ($RefreshToken -eq '' -or $TokenEp -eq '' -or $ClientId -eq '') {
    Write-Err "TokenScope: emission auth NOT CONFIGURED - no OAuth credential (TOKENSCOPE_OAUTH_REFRESH_TOKEN/_TOKEN_ENDPOINT/_CLIENT_ID, and none found in $Store); run the tokenscope-setup MCP prompt. Telemetry will not emit."
    Clear-Degraded
    Write-Sentinel 0 'no OAuth credential configured'
    exit 1
  }
  Assert-SafeEndpoint $TokenEp 'TOKENSCOPE_OAUTH_TOKEN_ENDPOINT'

  # Only a cache bound to THIS endpoint and not within the skew of expiry.
  $usedCache = $false
  if ([IO.File]::Exists($AccessCache)) {
    $ac = Read-JsonFile $AccessCache
    $acTok = Get-JsonStr $ac 'access_token'
    $acExp = Get-JsonInt $ac 'expires_at'
    if ($null -eq $acExp) { $acExp = 0 }
    if ($acTok -ne '' -and (Get-JsonStr $ac 'bearer_endpoint') -ceq $BearerEp -and $acExp -gt ((Get-NowEpoch) + $ExpirySkew)) {
      $AuthToken = $acTok
      $usedCache = $true
    }
  }
  if (-not $usedCache) { Invoke-OAuthRefresh }

  $resp = Invoke-Bearer

  # SELF-HEAL (Appendix A section 9): a CACHED token refused was probably
  # superseded by a concurrent refresh. Once: drop it, refresh, retry. The refusal
  # is a verdict until the retry proves otherwise.
  if ($usedCache -and ($resp.Status -eq 401 -or $resp.Status -eq 403)) {
    Remove-QuietFile $AccessCache
    $VerdictSeen = $true
    Remove-AzureCache
    Invoke-OAuthRefresh
    $resp = Invoke-Bearer
  }

  $st = $resp.Status
  $body = ConvertFrom-JsonObject $resp.Body
  if ($st -eq 200) {
    # Re-emit only the top-level string fields, compact: Claude Code needs one
    # JSON object of headers, and the .sh's "print the body" cannot promise one line.
    $auth = Get-JsonStr $body 'Authorization'
    if ($auth -eq '') {
      Write-Err 'TokenScope: emission auth FAILED (bearer endpoint returned no Authorization) - telemetry is being DROPPED. Run /tokenscope:status.'
      Write-Sentinel 200 'bearer endpoint returned no Authorization'
      exit 1
    }
    $parts = @()
    foreach ($prop in $body.PSObject.Properties) {
      if ($prop.Value -is [string]) { $parts += (ConvertTo-JsonString $prop.Name) + ':' + (ConvertTo-JsonString $prop.Value) }
    }
    Write-AzureCache $auth (Get-ResponseHeader $resp.Headers 'X-TokenScope-Bearer-Expires-At')
    Clear-Degraded
    Clear-Sentinel
    Write-HeaderAndExit ('{' + ($parts -join ',') + '}')
  }
  if ($st -eq 401 -or $st -eq 403) {
    # A FRESH token refused: revoked or ended. The cached Azure bearer goes too.
    Remove-QuietFile $AccessCache
    Remove-AzureCache
    Clear-Degraded
    $msg = Get-JsonStr $body 'statusMessage'
    if ($msg -eq '') { $msg = Get-JsonStr $body 'detail' }
    if ($msg -eq '') { $msg = 'Session expired or revoked' }
    Write-Err "TokenScope: emission auth FAILED (HTTP $st $msg) - telemetry is being DROPPED. Run /tokenscope:status or re-provision emit via the tokenscope-setup MCP prompt."
    Write-Sentinel $st $msg
    exit 1
  }
  if ($st -eq 0) {
    Use-CachedBearer "could not reach $BearerEp"
    Write-Err "TokenScope: emission auth FAILED (could not reach $BearerEp) - telemetry may be DROPPED. Check connectivity; run /tokenscope:status."
    Write-Sentinel 0 'network error reaching bearer endpoint'
    exit 1
  }
  if (Test-Transient $st) {
    Use-CachedBearer "bearer endpoint HTTP $st"
    Write-Err "TokenScope: emission auth FAILED (HTTP $st) - telemetry may be DROPPED. Run /tokenscope:status."
    Write-Sentinel $st "bearer endpoint returned HTTP $st"
    exit 1
  }
  # Any other status (3xx, 400, 404, 410): a verdict, not weather.
  Remove-AzureCache
  Clear-Degraded
  Write-Err "TokenScope: emission auth FAILED (HTTP $st) - telemetry may be DROPPED. Run /tokenscope:status or re-provision emit via the tokenscope-setup MCP prompt."
  Write-Sentinel $st "bearer endpoint returned HTTP $st"
  exit 1
} catch {
  # Never the exception message: it can quote a URL or a header.
  Write-Err ('TokenScope: emission auth FAILED (internal error: ' + $_.Exception.GetType().Name + ') - telemetry is being DROPPED. Run /tokenscope:status.')
  Write-Sentinel 0 ('helper internal error: ' + $_.Exception.GetType().Name)
  exit 1
}

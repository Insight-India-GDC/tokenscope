# claude-config-dir.ps1 - the Claude Code config folder and the Claude lane's
# state folder, for the PowerShell scripts (claude-redeem.ps1, status.ps1): the
# twins of claude-config-dir.mjs resolveClaudeConfigDir and plugin-runtime.mjs
# claudeStateDir / helperStateDir (#449). Dot-source it; it defines functions
# only. It loads ps-json.ps1 itself for the project-settings check.
#
# Claude Desktop runs Claude Code with its own CLAUDE_CONFIG_DIR, so a setup
# that always wrote <profile>\.claude gave the credential to the wrong install.
# The variable can also reach these scripts from a repository's settings env,
# and the folder decides where a durable credential is written, so it is
# honoured only when it is absolute, is inside the profile (not the profile
# itself), has no link below the profile, is not inside a git work tree, is a
# folder if it exists, and no project settings file from the working directory
# up names it.
#
# Windows PowerShell 5.1 syntax, ASCII only. Runs under pwsh 7 for the tests.

. ([System.IO.Path]::Combine($PSScriptRoot, 'ps-json.ps1'))

function Test-TsWindows {
  return ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
}

function Get-TsPathComparison {
  if (Test-TsWindows) { return [System.StringComparison]::OrdinalIgnoreCase }
  return [System.StringComparison]::Ordinal
}

# An error whose message is safe to print: it names, never echoes, a value.
function New-TsError([string]$Message, [string]$Reason) {
  $e = New-Object System.Exception -ArgumentList $Message
  $e.Data['reason'] = $Reason
  return $e
}

# argv-guard.mjs safeToken: a rejected token rendered in a fixed character set.
function Get-TsSafeToken([string]$Token) {
  $t = $Token
  if ($t.Length -gt 40) { $t = $t.Substring(0, 40) }
  return ($t -replace '[^A-Za-z0-9._=/:-]', '?')
}

function Get-TsProfileRoot {
  $root = [System.Environment]::GetFolderPath('UserProfile')
  if (-not $root) { throw (New-TsError 'cannot determine your profile directory' 'no-profile') }
  return [System.IO.Path]::GetFullPath($root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

# Does a directory entry exist at $Path, WITHOUT following a link? A dangling
# link is an entry. Returns its attributes, or $null.
function Get-TsEntryAttributes([string]$Path) {
  try {
    $a = (New-Object System.IO.FileInfo -ArgumentList $Path).Attributes
    if ([int]$a -eq -1) { return $null }
    return $a
  } catch {
    return $null
  }
}

function Test-TsUnder([string]$Path, [string]$Root) {
  $sep = [string][System.IO.Path]::DirectorySeparatorChar
  return ($Path.StartsWith($Root + $sep, (Get-TsPathComparison)))
}

# argv-guard.mjs assertConfinedPath, for a script that has no realpath.
#
# Node resolves symlinks and then checks containment. Windows PowerShell 5.1
# cannot resolve a junction or symlink target without P/Invoke, so this is
# STRICTER: any existing link (reparse point) below the profile root is
# refused, which is fail-closed for the same threat (a link that leads out of
# the profile, or into a repository).
function Resolve-TsConfinedPath([string]$Value, [string]$Flag, [string[]]$AllowedBasenames, [bool]$RefuseInsideRepo) {
  $root = Get-TsProfileRoot
  $sep = [System.IO.Path]::DirectorySeparatorChar
  try {
    $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).ProviderPath, $Value))
  } catch {
    throw (New-TsError "$(Get-TsSafeToken $Flag) could not be resolved to a real path inside your home directory ($root)" 'unresolvable-path')
  }
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd($sep) }
  $cmp = Get-TsPathComparison
  if (-not ($full.Equals($root, $cmp) -or (Test-TsUnder $full $root))) {
    throw (New-TsError "$(Get-TsSafeToken $Flag) must name a path inside your home directory ($root), and must not be a symlink out of it" 'outside-home')
  }
  # Every EXISTING component below the root must be a plain entry.
  $rel = $full.Substring($root.Length).TrimStart($sep)
  $cur = $root
  if ($rel) {
    foreach ($seg in $rel.Split($sep)) {
      $cur = $cur + $sep + $seg
      $attrs = Get-TsEntryAttributes $cur
      if ($null -eq $attrs) { break }
      if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw (New-TsError "$(Get-TsSafeToken $Flag) must name a path inside your home directory ($root), and must not be a symlink out of it" 'outside-home')
      }
    }
  }
  if ($AllowedBasenames -and $AllowedBasenames.Count -gt 0) {
    $leaf = [System.IO.Path]::GetFileName($full)
    if (-not ($AllowedBasenames -ccontains $leaf)) {
      throw (New-TsError "$(Get-TsSafeToken $Flag) must name one of: $($AllowedBasenames -join ', ')" 'unexpected-filename')
    }
  }
  if ($RefuseInsideRepo) {
    $dir = $full
    if ($AllowedBasenames -and $AllowedBasenames.Count -gt 0) { $dir = [System.IO.Path]::GetDirectoryName($full) }
    # The root itself is EXCLUSIVE, as in Node: a version-controlled profile
    # does not refuse every path.
    while ($dir -and (Test-TsUnder $dir $root)) {
      if ($null -ne (Get-TsEntryAttributes ([System.IO.Path]::Combine($dir, '.git')))) {
        throw (New-TsError "$(Get-TsSafeToken $Flag) must not name a path inside a git repository - it receives a durable credential, and a repository publishes what is written into it" 'inside-repository')
      }
      $parent = [System.IO.Path]::GetDirectoryName($dir)
      if (-not $parent -or $parent -eq $dir) { break }
      $dir = $parent
    }
  }
  return $full
}

# claude-config-dir.mjs projectSetsEnvKey: does a PROJECT settings file
# (.claude\settings.json or settings.local.json, from $Cwd up to the root) name
# $Key in its env? A present file that cannot be read as JSON counts as naming
# it (fail closed). $UserFile, the user's own settings file, is not a project file.
function Test-TsProjectSetsEnvKey([string]$Key, [string]$Cwd, [string]$UserFile) {
  $cmp = Get-TsPathComparison
  $dir = [System.IO.Path]::GetFullPath($Cwd)
  for ($n = 0; $n -lt 256; $n++) {
    foreach ($f in @('settings.json', 'settings.local.json')) {
      $path = [System.IO.Path]::Combine([System.IO.Path]::Combine($dir, '.claude'), $f)
      if ($UserFile -and $path.Equals($UserFile, $cmp)) { continue }
      if ($null -eq (Get-TsEntryAttributes $path)) { continue }
      try {
        $info = New-Object System.IO.FileInfo -ArgumentList $path
        if (($info.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { return $true }
        if ($info.Length -gt 1048576) { return $true }
        $doc = ConvertFrom-TsJson (ConvertFrom-TsUtf8 ([System.IO.File]::ReadAllBytes($path)))
      } catch {
        return $true
      }
      if (-not (Test-TsJsonObject $doc)) { return $true }
      $envObj = Get-TsJsonMember $doc 'env'
      if ((Test-TsJsonObject $envObj) -and $envObj.Contains($Key)) { return $true }
    }
    $parent = [System.IO.Path]::GetDirectoryName($dir)
    if (-not $parent -or $parent -eq $dir) { return $false }
    $dir = $parent
  }
  return $true
}

# claude-config-dir.mjs resolveClaudeConfigDir: @{ Dir; Source; Refused }.
# Refused is $null, or the reason a set CLAUDE_CONFIG_DIR was not used.
function Resolve-TsClaudeConfigDir([string]$ProfileRoot) {
  $default = [System.IO.Path]::Combine($ProfileRoot, '.claude')
  $raw = [string]$env:CLAUDE_CONFIG_DIR
  $raw = $raw.Trim()
  if (-not $raw) { return @{ Dir = $default; Source = 'default'; Refused = $null } }
  $refuse = { param($reason) return @{ Dir = $default; Source = 'default'; Refused = $reason } }
  if (-not [System.IO.Path]::IsPathRooted($raw)) { return (& $refuse 'not-absolute') }
  $userFile = [System.IO.Path]::Combine($default, 'settings.json')
  if (Test-TsProjectSetsEnvKey 'CLAUDE_CONFIG_DIR' ((Get-Location).ProviderPath) $userFile) { return (& $refuse 'set-by-project') }
  try {
    $full = Resolve-TsConfinedPath $raw 'CLAUDE_CONFIG_DIR' @() $true
  } catch {
    $reason = [string]$_.Exception.Data['reason']
    if (-not $reason) { $reason = 'outside-home' }
    return (& $refuse $reason)
  }
  if ($full.Equals($ProfileRoot, (Get-TsPathComparison))) { return (& $refuse 'is-home') }
  if ([System.IO.File]::Exists($full)) { return (& $refuse 'not-a-directory') }
  return @{ Dir = $full; Source = 'env'; Refused = $null }
}

# plugin-runtime.mjs claudeStateDir: <profile>\.tokenscope for the default
# config folder, else <profile>\.tokenscope\claude-config\<12 hex of sha256 of
# the folder> (lower-cased on Windows, as Node keys it), so Desktop's install
# and the CLI's keep separate device stores.
function Get-TsClaudeStateDir([string]$ConfigDir, [string]$ProfileRoot) {
  $trusted = [System.IO.Path]::Combine($ProfileRoot, '.tokenscope')
  $dir = [System.IO.Path]::GetFullPath($ConfigDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $default = [System.IO.Path]::Combine($ProfileRoot, '.claude')
  if ($dir.Equals($default, (Get-TsPathComparison))) { return $trusted }
  if (Test-TsWindows) { $dir = $dir.ToLowerInvariant() }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($dir))
  } finally {
    $sha.Dispose()
  }
  $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  return [System.IO.Path]::Combine([System.IO.Path]::Combine($trusted, 'claude-config'), $hex.Substring(0, 12))
}

# plugin-runtime.mjs helperStateDir: the --state-dir the settings helper
# command names, when it is a confined path; the default <profile>\.tokenscope
# for a helper without one (an install enrolled before #449); else, with no
# helper yet, Get-TsClaudeStateDir.
function Get-TsHelperStateDir([string]$HelperCommand, [string]$ConfigDir, [string]$ProfileRoot) {
  if ($HelperCommand -match '(?:^|\s)--state-dir\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))') {
    $quoted = $Matches[1]
    $named = $Matches[2]
    if ($quoted) {
      # env-builder.mjs quoteCmd on Windows (no escapes; only a trailing
      # backslash run is doubled) and quoteSh elsewhere (\ escapes).
      if (Test-TsWindows) { $named = $quoted.TrimEnd('\') } else { $named = $quoted -replace '\\(.)', '$1' }
    }
    try {
      return (Resolve-TsConfinedPath $named '--state-dir' @() $true)
    } catch { }
  } elseif ($HelperCommand -and $HelperCommand.Trim()) {
    return [System.IO.Path]::Combine($ProfileRoot, '.tokenscope')
  }
  return (Get-TsClaudeStateDir $ConfigDir $ProfileRoot)
}

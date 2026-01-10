param(
  [int] $Top = 10,
  [int] $SinceHours,
  [string[]] $Keywords = @(),
  [string[]] $BoostKeywords = @(),
  [switch] $ShowRawTrends,
  [switch] $Json
)

$ErrorActionPreference = 'Stop'

function Get-Settings {
  $settingsPath = Join-Path $PSScriptRoot 'settings.psd1'
  if (Test-Path $settingsPath) {
    return (Import-PowerShellDataFile -Path $settingsPath)
  }
  return @{}
}

function Parse-TrendLine {
  param([string] $Line)

  # Expected:
  # 2026-01-10T12:34:56 | Source | Title | Link
  $parts = $Line -split '\s+\|\s+'
  if ($parts.Count -lt 4) { return $null }

  try { $dt = [datetime]::Parse($parts[0]) } catch { return $null }

  [pscustomobject]@{
    Date   = $dt
    Source = [string]$parts[1]
    Title  = [string]$parts[2]
    Link   = [string]$parts[3]
    Raw    = $Line
  }
}

function Matches-Keywords {
  param([pscustomobject] $Entry, [string[]] $Needles)
  if ($Needles.Count -eq 0) { return $true }

  $hay = (($Entry.Title + ' ' + $Entry.Link + ' ' + $Entry.Source).ToLowerInvariant())
  foreach ($k in $Needles) {
    $kk = ([string]$k).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($kk)) { continue }
    if ($hay -like ('*' + $kk + '*')) { return $true }
  }
  return $false
}

function Score-Entry {
  param([pscustomobject] $e, [datetime] $Now, [string[]] $Boost)

  $score = 0
  $reasons = New-Object System.Collections.Generic.List[string]

  $src = $e.Source.ToLowerInvariant()
  if ($src -like '*devblogs.microsoft.com/dotnet*') { $score += 6; $reasons.Add('official: devblogs') }
  elseif ($src -like '*github.com/*/releases.atom*') { $score += 6; $reasons.Add('official-ish: GitHub releases') }
  elseif ($src -like '*reddit.com/r/*') { $score += 2; $reasons.Add('social: reddit') }
  elseif ($src -like '*hnrss.org*') { $score += 1; $reasons.Add('social: hn') }
  else { $score += 1; $reasons.Add('source: other') }

  $age = $Now - $e.Date
  if ($age.TotalHours -le 24) { $score += 4; $reasons.Add('recency: <24h') }
  elseif ($age.TotalHours -le 48) { $score += 2; $reasons.Add('recency: <48h') }

  $hay = ($e.Title + ' ' + $e.Link).ToLowerInvariant()
  if ($hay -match '\b(v?\d+(\.\d+){1,3}([\-\.](preview|rc|dev))?\w*)\b') { $score += 2; $reasons.Add('has version') }
  if ($hay -like '*pull*' -or $hay -like '*github.com/*/pull/*') { $score += 2; $reasons.Add('links to PR') }
  if ($hay -like '*release*' -or $hay -like '*preview*' -or $hay -like '*rc*') { $score += 2; $reasons.Add('release-ish') }
  if ($hay -like '*dotnet*' -or $hay -like '*csharp*' -or $hay -like '*flutter*' -or $hay -like '*dart*') { $score += 1; $reasons.Add('in-scope stack') }

  foreach ($k in $Boost) {
    $kk = ([string]$k).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($kk)) { continue }
    if ($hay -like ('*' + $kk + '*')) { $score += 2; $reasons.Add('keyword: ' + $kk) }
  }

  [pscustomobject]@{
    Score   = $score
    Reasons = ($reasons | Select-Object -Unique) -join ', '
  }
}

$settings = Get-Settings
$ua = if ($settings.UserAgent) { [string]$settings.UserAgent } else { 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0' }
$urls = if ($settings.TrendUrls) { [string[]]$settings.TrendUrls } else { @() }

if (-not $PSBoundParameters.ContainsKey('SinceHours')) {
  $SinceHours = if ($settings.SinceHours) { [int]$settings.SinceHours } else { 48 }
}

$fetch = Join-Path $PSScriptRoot 'fetch-trends.ps1'
if (-not (Test-Path $fetch)) { throw "Missing script: $fetch" }

# Fetch and keep only valid trend lines.
$raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $fetch -SinceHours $SinceHours -UserAgent $ua -Urls $urls -Quiet
$lines = @($raw | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\s+\|\s+' })

if ($ShowRawTrends) {
  if (-not $Json) {
    $lines | ForEach-Object { Write-Host $_ }
    Write-Host ""
  }
}

$needles = @($Keywords | Where-Object { $_ -and $_.Trim() -ne '' })
$boost = @($BoostKeywords | Where-Object { $_ -and $_.Trim() -ne '' })
$since = (Get-Date).AddHours(-1 * $SinceHours)

$entries = @(
  $lines |
    ForEach-Object { Parse-TrendLine $_ } |
    Where-Object { $_ -and $_.Date -ge $since } |
    Where-Object { Matches-Keywords -Entry $_ -Needles $needles }
)

# Dedup by link when possible.
$entries = $entries | Group-Object Link | ForEach-Object { $_.Group | Select-Object -First 1 }

$now = Get-Date
$scored = $entries | ForEach-Object {
  $s = Score-Entry -e $_ -Now $now -Boost $boost
  [pscustomobject]@{
    Score   = $s.Score
    Date    = $_.Date
    Source  = $_.Source
    Title   = $_.Title
    Link    = $_.Link
    Why     = $s.Reasons
  }
} | Sort-Object @{ Expression = 'Score'; Descending = $true }, @{ Expression = 'Date'; Descending = $true }

if ($Top -gt 0) { $scored = $scored | Select-Object -First $Top }

if (($scored | Measure-Object).Count -eq 0) {
  if ($Json) {
    [pscustomobject]@{
      WindowHours = $SinceHours
      Filter      = @($needles)
      Boost       = @($boost)
      Candidates  = @()
      Duplicates  = $null
    } | ConvertTo-Json -Depth 10
  } else {
    Write-Host ("WINDOW: last {0}h" -f $SinceHours)
    if ($needles.Count -gt 0) { Write-Host ("FILTER: " + ($needles -join ', ')) }
    if ($boost.Count -gt 0) { Write-Host ("BOOST: " + ($boost -join ', ')) }
    Write-Host ""
    Write-Host "No candidates found."
  }
  exit 0
}

if (-not $Json) {
  Write-Host ("WINDOW: last {0}h" -f $SinceHours)
  if ($needles.Count -gt 0) { Write-Host ("FILTER: " + ($needles -join ', ')) }
  if ($boost.Count -gt 0) { Write-Host ("BOOST: " + ($boost -join ', ')) }
  Write-Host ""

  Write-Host ("Top {0} candidates:" -f ($scored | Measure-Object).Count)
  Write-Host ""

  $scored | ForEach-Object {
    Write-Host ("{0} | {1} | {2}" -f $_.Score, $_.Date.ToString('s'), $_.Title)
    Write-Host ("  link:   {0}" -f $_.Link)
    Write-Host ("  source: {0}" -f $_.Source)
    Write-Host ("  why:    {0}" -f $_.Why)
    Write-Host ""
  }
}

$dupes = $null

if ($needles.Count -gt 0) {
  $sd = Join-Path $PSScriptRoot 'sd-search.ps1'
  if (Test-Path $sd) {
    $internal = & powershell -NoProfile -ExecutionPolicy Bypass -File $sd -Keywords $needles -Json | ConvertFrom-Json
  } else {
    $internal = $null
  }

  $dc = Join-Path $PSScriptRoot 'dupe-check.ps1'
  if (Test-Path $dc) {
    $q = "site:startdebugging.net " + ($needles -join ' ')
    $external = & powershell -NoProfile -ExecutionPolicy Bypass -File $dc -Query $q -Json | ConvertFrom-Json
  } else {
    $external = $null
  }

  $dupes = [pscustomobject]@{
    Internal = $internal
    External = $external
  }

  if (-not $Json) {
    Write-Host "Duplicate checks (keywords):"
    Write-Host ""
    if ($null -ne $internal) {
      $internal.All | ForEach-Object { Write-Host $_ }
      Write-Host ""
    }
    if ($null -ne $external) {
      $external.Urls | ForEach-Object { Write-Host $_ }
      Write-Host ""
    }
  }
}

if ($Json) {
  [pscustomobject]@{
    WindowHours = $SinceHours
    Filter      = @($needles)
    Boost       = @($boost)
    Candidates  = @($scored)
    Duplicates  = $dupes
  } | ConvertTo-Json -Depth 10
}


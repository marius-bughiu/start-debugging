param(
  [string] $InputFile,
  [string[]] $Keywords = @(),
  [int] $SinceHours = 48,
  [int] $Top = 200,
  [switch] $ShowSourceCounts
)

$ErrorActionPreference = 'Stop'

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

$lines = @()
if (-not [string]::IsNullOrWhiteSpace($InputFile)) {
  if (-not (Test-Path $InputFile)) { throw "InputFile not found: $InputFile" }
  $lines = Get-Content $InputFile
} else {
  # Read from pipeline/stdin if available; otherwise, show usage.
  if ($MyInvocation.ExpectingInput) {
    $lines = @($input)
  } else {
    throw "Usage: powershell -File tools\fetch-trends.ps1 | powershell -File tools\filter-trends.ps1 -Keywords dotnet,flutter"
  }
}

$since = (Get-Date).AddHours(-1 * $SinceHours)
$needles = @($Keywords | Where-Object { $_ -and $_.Trim() -ne '' })

$entries = @(
  $lines |
    ForEach-Object { Parse-TrendLine $_ } |
    Where-Object { $_ -and $_.Date -ge $since } |
    Where-Object { Matches-Keywords -Entry $_ -Needles $needles }
)

$entries = $entries | Sort-Object Date -Descending
if ($Top -gt 0) { $entries = $entries | Select-Object -First $Top }

if ($ShowSourceCounts) {
  Write-Host "SOURCE COUNTS:"
  $entries | Group-Object Source | Sort-Object Count -Descending | ForEach-Object {
    Write-Host ("- {0}: {1}" -f $_.Name, $_.Count)
  }
  Write-Host ""
}

$entries | ForEach-Object { $_.Raw }


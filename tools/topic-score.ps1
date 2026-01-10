param(
  [string] $InputFile,
  [int] $SinceHours = 48,
  [int] $Top = 10,
  [string[]] $BoostKeywords = @()
)

$ErrorActionPreference = 'Stop'

function Parse-TrendLine {
  param([string] $Line)

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

$lines = @()
if (-not [string]::IsNullOrWhiteSpace($InputFile)) {
  if (-not (Test-Path $InputFile)) { throw "InputFile not found: $InputFile" }
  $lines = Get-Content $InputFile
} else {
  if ($MyInvocation.ExpectingInput) {
    $lines = @($input)
  } else {
    throw "Usage: powershell -File tools\fetch-trends.ps1 | powershell -File tools\topic-score.ps1 -Top 10"
  }
}

$since = (Get-Date).AddHours(-1 * $SinceHours)
$entries = @(
  $lines |
    ForEach-Object { Parse-TrendLine $_ } |
    Where-Object { $_ -and $_.Date -ge $since }
)

# Dedup by Link if present; otherwise Title.
$entries = $entries | Group-Object Link | ForEach-Object { $_.Group | Select-Object -First 1 }

$now = Get-Date
$boost = @($BoostKeywords | Where-Object { $_ -and $_.Trim() -ne '' })

$scored = $entries | ForEach-Object {
  $s = Score-Entry -e $_ -Now $now -Boost $boost
  [pscustomobject]@{
    Score   = $s.Score
    Date    = $_.Date
    Source  = $_.Source
    Title   = $_.Title
    Link    = $_.Link
    Reasons = $s.Reasons
  }
} | Sort-Object @{ Expression = 'Score'; Descending = $true }, @{ Expression = 'Date'; Descending = $true }

if ($Top -gt 0) { $scored = $scored | Select-Object -First $Top }

$scored | ForEach-Object {
  Write-Host ("{0} | {1} | {2}" -f $_.Score, $_.Date.ToString('s'), $_.Title)
  Write-Host ("  source: {0}" -f $_.Source)
  Write-Host ("  link:   {0}" -f $_.Link)
  Write-Host ("  why:    {0}" -f $_.Reasons)
  Write-Host ""
}


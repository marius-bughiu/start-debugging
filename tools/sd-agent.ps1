param(
  [int] $Top = 10,
  [int] $SinceHours,
  [string[]] $Keywords = @(),
  [string[]] $BoostKeywords = @(),
  [int] $EnrichTop = 5
)

$ErrorActionPreference = 'Stop'

$daily = Join-Path $PSScriptRoot 'sd-daily.ps1'
if (-not (Test-Path $daily)) { throw "Missing script: $daily" }

$meta = Join-Path $PSScriptRoot 'url-meta.ps1'
if (-not (Test-Path $meta)) { throw "Missing script: $meta" }

# 1) Get candidates + dupes in JSON.
$args = @('-Top', $Top)
if ($BoostKeywords.Count -gt 0) {
  $args += @('-BoostKeywords')
  $args += @($BoostKeywords)
}
if ($Keywords.Count -gt 0) {
  $args += @('-Keywords')
  $args += @($Keywords)
}
$args += @('-Json')


$payload = & powershell -NoProfile -ExecutionPolicy Bypass -File $daily @args | ConvertFrom-Json

# 2) Enrich top N links with normalized metadata (no decisions, just evidence).
$enrichCount = [Math]::Max(0, [Math]::Min($EnrichTop, ($payload.Candidates | Measure-Object).Count))
$enriched = @()

for ($i = 0; $i -lt $enrichCount; $i++) {
  $c = $payload.Candidates[$i]
  if ($null -eq $c -or [string]::IsNullOrWhiteSpace([string]$c.Link)) { continue }
  $m = & powershell -NoProfile -ExecutionPolicy Bypass -File $meta -Url $c.Link | ConvertFrom-Json
  $enriched += [pscustomobject]@{
    Candidate = $c
    Meta      = $m
  }
}

[pscustomobject]@{
  WindowHours = $payload.WindowHours
  Filter      = $payload.Filter
  Boost       = $payload.Boost
  Candidates  = $payload.Candidates
  Duplicates  = $payload.Duplicates
  Evidence    = $enriched
} | ConvertTo-Json -Depth 12


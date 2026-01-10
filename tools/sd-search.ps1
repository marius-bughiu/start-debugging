param(
  [Parameter(Mandatory = $true)]
  [string[]] $Keywords,

  [switch] $RawUrls,
  [switch] $Json
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$wp = Join-Path $root 'wp-site-search.ps1'
$sm = Join-Path $root 'sitemap-keyword.ps1'

if (-not (Test-Path $wp)) { throw "Missing script: $wp" }
if (-not (Test-Path $sm)) { throw "Missing script: $sm" }

$terms = @(
  $Keywords |
    ForEach-Object { ([string]$_) -split ',' } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)
if ($terms.Count -eq 0) { throw "Provide at least 1 keyword." }

# 1) WordPress on-site search for the combined phrase (best for true content matches).
$phrase = ($terms -join ' ')
$wpObj = $null
try { $wpObj = (& powershell -NoProfile -ExecutionPolicy Bypass -File $wp -Term $phrase -Json) | ConvertFrom-Json } catch { $wpObj = $null }
$wpUrls = @()
if ($null -ne $wpObj -and $wpObj.Urls) { $wpUrls = @($wpObj.Urls) }
$wpUrls = @($wpUrls | Where-Object { $_ -match '^https?://startdebugging\.net/' } | Select-Object -Unique)

# 2) Sitemap slug match for any keyword (good fallback when WP search page changes structure).
$smObj = $null
$minHits = 1
if ($terms.Count -ge 2) { $minHits = 2 }
if ($terms.Count -ge 4) { $minHits = 3 }
try { $smObj = (& powershell -NoProfile -ExecutionPolicy Bypass -File $sm -Keywords ($terms -join ',') -MinHits $minHits -Json) | ConvertFrom-Json } catch { $smObj = $null }
$smUrls = @()
if ($null -ne $smObj -and $smObj.Matches) { $smUrls = @($smObj.Matches) }
$smUrls = @($smUrls | Where-Object { $_ -match '^https?://startdebugging\.net/' } | Select-Object -Unique)

function Is-ContentUrl {
  param([string] $Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
  # Most posts follow /YYYY/MM/slug/. Keep the dupe-check focused and high-signal.
  if ($Url -match '^https?://startdebugging\.net/\d{4}/\d{2}/') { return $true }
  return $false
}

$wpUrls = @($wpUrls | Where-Object { Is-ContentUrl $_ } | Select-Object -Unique)
$smUrls = @($smUrls | Where-Object { Is-ContentUrl $_ } | Select-Object -Unique)

$all = @($wpUrls + $smUrls) | Select-Object -Unique

if ($Json) {
  [pscustomobject]@{
    Keywords    = @($terms)
    WordPress   = @($wpUrls)
    Sitemap     = @($smUrls)
    All         = @($all)
    Counts      = [pscustomobject]@{
      WordPress = $wpUrls.Count
      Sitemap   = $smUrls.Count
      Total     = $all.Count
    }
  } | ConvertTo-Json -Depth 6
  exit 0
}

if ($RawUrls) {
  $all | ForEach-Object { Write-Output $_ }
  exit 0
}

Write-Host ("KEYWORDS: {0}" -f ($terms -join ', '))
Write-Host ("WP SEARCH URLS: {0}" -f $wpUrls.Count)
Write-Host ("SITEMAP URLS: {0}" -f $smUrls.Count)
Write-Host ("TOTAL UNIQUE: {0}" -f $all.Count)
Write-Host ""

if ($all.Count -eq 0) {
  Write-Host "MATCHES: (none)"
} else {
  Write-Host "MATCHES:"
  $all | ForEach-Object { Write-Host $_ }
}


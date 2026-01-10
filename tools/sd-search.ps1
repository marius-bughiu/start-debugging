param(
  [Parameter(Mandatory = $true)]
  [string[]] $Keywords,

  [switch] $RawUrls
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$wp = Join-Path $root 'wp-site-search.ps1'
$sm = Join-Path $root 'sitemap-keyword.ps1'

if (-not (Test-Path $wp)) { throw "Missing script: $wp" }
if (-not (Test-Path $sm)) { throw "Missing script: $sm" }

$terms = @($Keywords | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($terms.Count -eq 0) { throw "Provide at least 1 keyword." }

# 1) WordPress on-site search for the combined phrase (best for true content matches).
$phrase = ($terms -join ' ')
$wpOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $wp -Term $phrase 2>$null
$wpUrls = @($wpOutput | Where-Object { $_ -match '^https?://startdebugging\.net/' } | Select-Object -Unique)

# 2) Sitemap slug match for any keyword (good fallback when WP search page changes structure).
$smOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $sm -Keywords $terms 2>$null
$smUrls = @($smOutput | Where-Object { $_ -match '^https?://startdebugging\.net/' } | Select-Object -Unique)

$all = @($wpUrls + $smUrls) | Select-Object -Unique

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


param(
  [Parameter(Mandatory = $true)]
  [string[]] $Keywords,

  # If set, also runs the external (search-engine) checks via dupe-check.ps1.
  [switch] $IncludeExternal,

  [switch] $Json
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$wp = Join-Path $root 'wp-site-search.ps1'
$sm = Join-Path $root 'sitemap-keyword.ps1'
$dc = Join-Path $root 'dupe-check.ps1'

if (-not (Test-Path $wp)) { throw "Missing script: $wp" }
if (-not (Test-Path $sm)) { throw "Missing script: $sm" }

$terms = @(
  $Keywords |
    ForEach-Object { ([string]$_) -split ',' } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)
if ($terms.Count -eq 0) { throw "Provide at least 1 keyword." }

function Extract-Urls {
  param([object[]] $Lines)
  @($Lines | Where-Object { $_ -match '^https?://startdebugging\.net/' } | Select-Object -Unique)
}

# --- Internal checks (authoritative) ---
#
# 1) WP on-site search:
#    - combined phrase (better for exact topic matches)
#    - each keyword separately (better for partial matches)
#
# 2) Sitemap slug match for any keyword (fast and resilient).

$phrase = ($terms -join ' ')
$wpPhraseObj = $null
try { $wpPhraseObj = (& powershell -NoProfile -ExecutionPolicy Bypass -File $wp -Term $phrase -Json) | ConvertFrom-Json } catch { $wpPhraseObj = $null }
$wpPhraseUrls = @()
if ($null -ne $wpPhraseObj -and $wpPhraseObj.Urls) { $wpPhraseUrls = @($wpPhraseObj.Urls) }
$wpPhraseUrls = Extract-Urls -Lines $wpPhraseUrls

$wpTermUrls = @()
foreach ($t in $terms) {
  $wpTermObj = $null
  try { $wpTermObj = (& powershell -NoProfile -ExecutionPolicy Bypass -File $wp -Term $t -Json) | ConvertFrom-Json } catch { $wpTermObj = $null }
  if ($null -ne $wpTermObj -and $wpTermObj.Urls) { $wpTermUrls += @($wpTermObj.Urls) }
}
$wpTermUrls = @($wpTermUrls | Select-Object -Unique)

$smObj = $null
$minHits = 1
if ($terms.Count -ge 2) { $minHits = 2 }
if ($terms.Count -ge 4) { $minHits = 3 }
try { $smObj = (& powershell -NoProfile -ExecutionPolicy Bypass -File $sm -Keywords ($terms -join ',') -MinHits $minHits -Json) | ConvertFrom-Json } catch { $smObj = $null }
$smUrls = @()
if ($null -ne $smObj -and $smObj.Matches) { $smUrls = @($smObj.Matches) }
$smUrls = Extract-Urls -Lines $smUrls

function Is-ContentUrl {
  param([string] $Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
  # Keep duplicates focused on published content (posts). This avoids noisy matches
  # from category/tag/author/media sitemaps where generic keywords like "net" explode.
  if ($Url -match '^https?://startdebugging\.net/\d{4}/\d{2}/') { return $true }
  return $false
}

$wpPhraseUrls = @($wpPhraseUrls | Where-Object { Is-ContentUrl $_ } | Select-Object -Unique)
$wpTermUrls = @($wpTermUrls | Where-Object { Is-ContentUrl $_ } | Select-Object -Unique)
$smUrls = @($smUrls | Where-Object { Is-ContentUrl $_ } | Select-Object -Unique)

$internalAll = @($wpPhraseUrls + $wpTermUrls + $smUrls) | Select-Object -Unique

# --- External checks (best-effort; can be incomplete) ---
$externalSite = $null
$externalBlog = $null
$externalAll = @()

if ($IncludeExternal) {
  if (-not (Test-Path $dc)) { throw "Missing script: $dc" }
  $q1 = "site:startdebugging.net " + ($terms -join ' ')
  $q2 = "site:startdebugging.net/blog " + ($terms -join ' ')

  try { $externalSite = & powershell -NoProfile -ExecutionPolicy Bypass -File $dc -Query $q1 -Json | ConvertFrom-Json } catch { $externalSite = $null }
  try { $externalBlog = & powershell -NoProfile -ExecutionPolicy Bypass -File $dc -Query $q2 -Json | ConvertFrom-Json } catch { $externalBlog = $null }

  if ($null -ne $externalSite -and $externalSite.Urls) { $externalAll += @($externalSite.Urls) }
  if ($null -ne $externalBlog -and $externalBlog.Urls) { $externalAll += @($externalBlog.Urls) }

  $externalAll = @($externalAll | Where-Object { $_ -match '^https?://startdebugging\.net/' } | Select-Object -Unique)
}

$result = [pscustomobject]@{
  Keywords = @($terms)
  Internal = [pscustomobject]@{
    PhraseSearch = @($wpPhraseUrls)
    TermSearch   = @($wpTermUrls)
    Sitemap      = @($smUrls)
    All          = @($internalAll)
    Counts       = [pscustomobject]@{
      PhraseSearch = $wpPhraseUrls.Count
      TermSearch   = $wpTermUrls.Count
      Sitemap      = $smUrls.Count
      Total        = $internalAll.Count
    }
  }
  External = [pscustomobject]@{
    Enabled = [bool]$IncludeExternal
    Site    = $externalSite
    Blog    = $externalBlog
    All     = @($externalAll)
    Count   = $externalAll.Count
  }
}

if ($Json) {
  $result | ConvertTo-Json -Depth 10
  exit 0
}

Write-Host ("KEYWORDS: {0}" -f ($terms -join ', '))
Write-Host ""
Write-Host "INTERNAL (StartDebugging authoritative):"
Write-Host ("  phrase search: {0}" -f $wpPhraseUrls.Count)
Write-Host ("  term search:   {0}" -f $wpTermUrls.Count)
Write-Host ("  sitemap:       {0}" -f $smUrls.Count)
Write-Host ("  total unique:  {0}" -f $internalAll.Count)
Write-Host ""

if ($internalAll.Count -eq 0) {
  Write-Host "INTERNAL MATCHES: (none)"
} else {
  Write-Host "INTERNAL MATCHES:"
  $internalAll | ForEach-Object { Write-Host $_ }
}

if ($IncludeExternal) {
  Write-Host ""
  Write-Host "EXTERNAL (best-effort; may be incomplete):"
  Write-Host ("  total unique: {0}" -f $externalAll.Count)
  if ($externalAll.Count -eq 0) {
    Write-Host "EXTERNAL MATCHES: (none)"
  } else {
    Write-Host "EXTERNAL MATCHES:"
    $externalAll | ForEach-Object { Write-Host $_ }
  }
}


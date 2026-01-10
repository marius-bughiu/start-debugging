param(
  [Parameter(Mandatory = $true)]
  [string[]] $Keywords,

  [string[]] $Sitemaps = @(
    # Prefer the index - it fan-outs to post/page/etc sitemaps.
    'https://startdebugging.net/sitemap_index.xml',
    # Fallbacks (some WP setups expose these):
    'https://startdebugging.net/sitemap.xml',
    'https://startdebugging.net/post-sitemap.xml',
    'https://startdebugging.net/page-sitemap.xml'
  ),

  # Emit only matching URLs to the pipeline (no extra text).
  [switch] $RawUrls,

  # Require at least N keyword hits in the URL (case-insensitive substring match).
  # Useful to avoid noisy matches on generic tokens (e.g., "net").
  [int] $MinHits = 1,

  [switch] $Json
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

function Get-SitemapLocs {
  param([string] $Url)

  try {
    $Resp = Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent } -Uri $Url -TimeoutSec 30
    [xml]$Xml = $Resp.Content

    # Sitemap namespaces vary; easiest is to ignore namespaces and select all <loc>.
    $locs = @($Xml.SelectNodes("//*[local-name()='loc']") | ForEach-Object { [string]$_.InnerText } | Where-Object { $_ })

    # If this is a sitemap index, the <loc> values are sitemap URLs (xml). Fan-out one level.
    $isIndex = ($null -ne $Xml.sitemapindex) -or ($Resp.Content -match '<\s*sitemapindex\b')
    if ($isIndex) {
      $childSitemaps = @($locs | Where-Object { $_ -match '\.xml(\?.*)?$' } | Select-Object -Unique)
      $childLocs = @()
      foreach ($sm in $childSitemaps) {
        $childLocs += Get-SitemapLocs -Url $sm
      }
      return @($childLocs)
    }

    return @($locs)
  }
  catch {
    return @()
  }
}

$AllLocs = @()
foreach ($sm in $Sitemaps) {
  $AllLocs += Get-SitemapLocs -Url $sm
}

$AllLocs = $AllLocs | Select-Object -Unique

$terms = @(
  $Keywords |
    ForEach-Object { ([string]$_) -split ',' } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)

function Get-NeedleVariants {
  param([string] $Term)

  $t = ''
  if ($null -ne $Term) { $t = [string]$Term }
  $t = $t.Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($t)) { return @() }

  # URL slug normalization: dots/underscores frequently become hyphens in slugs.
  $slug = $t.
    Replace('`', '').
    Replace('.', '-').
    Replace('_', '-').
    Replace(' ', '-')

  # Collapse duplicate hyphens.
  while ($slug -like '*--*') { $slug = $slug.Replace('--', '-') }
  $slug = $slug.Trim('-')

  @($t, $slug) | Where-Object { $_ } | Select-Object -Unique
}

# Each term becomes a group of needle variants; a URL "hit" is per-term (not per-variant).
$groups = @(
  $terms | ForEach-Object {
    [pscustomobject]@{
      Term    = $_
      Needles = @(Get-NeedleVariants -Term $_)
    }
  }
)

$matches = $AllLocs | Where-Object {
  $u = $_.ToLowerInvariant()
  $hits = 0
  foreach ($g in $groups) {
    $matched = $false
    foreach ($k in $g.Needles) {
      if ($u -like ("*" + $k + "*")) { $matched = $true; break }
    }
    if ($matched) { $hits++ }
  }
  return ($hits -ge $MinHits)
} | Select-Object -Unique

if ($RawUrls) {
  $matches | ForEach-Object { Write-Output $_ }
  exit 0
}

if ($Json) {
  [pscustomobject]@{
    Keywords      = @($terms)
    Sitemaps      = @($Sitemaps)
    LoadedUrls    = $AllLocs.Count
    Matches       = @($matches)
    MatchCount    = ($matches | Measure-Object).Count
  } | ConvertTo-Json -Depth 6
} else {
  Write-Host ("Loaded {0} URLs from {1} sitemaps." -f $AllLocs.Count, $Sitemaps.Count)
  if ($matches.Count -eq 0) {
    Write-Host "MATCHES: (none)"
  } else {
    Write-Host "MATCHES:"
    $matches | ForEach-Object { Write-Host $_ }
  }
}



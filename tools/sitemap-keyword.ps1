param(
  [Parameter(Mandatory = $true)]
  [string[]] $Keywords,

  [string[]] $Sitemaps = @(
    'https://startdebugging.net/post-sitemap.xml',
    'https://startdebugging.net/page-sitemap.xml'
  ),

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
    $locs = $Xml.SelectNodes("//*[local-name()='loc']") | ForEach-Object { [string]$_.InnerText }
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

$needles = $Keywords | ForEach-Object { $_.ToLowerInvariant() }

$matches = $AllLocs | Where-Object {
  $u = $_.ToLowerInvariant()
  foreach ($k in $needles) {
    if ($u -like ("*" + $k + "*")) { return $true }
  }
  return $false
} | Select-Object -Unique

if ($Json) {
  [pscustomobject]@{
    Keywords      = @($Keywords)
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



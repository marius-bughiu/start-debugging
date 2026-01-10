param(
  [Parameter(Mandatory = $true)]
  [string] $Url
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

function Try-FirstMatch {
  param([string] $Text, [string] $Pattern, [string] $GroupName = 'v')
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $m = [regex]::Match($Text, $Pattern, 'IgnoreCase')
  if ($m.Success) { return $m.Groups[$GroupName].Value }
  return $null
}

function Normalize-Url {
  param([string] $u)
  try {
    $uri = [uri]$u
    # Drop fragments; keep query because it may be meaningful (HN/Reddit).
    $builder = New-Object System.UriBuilder($uri)
    $builder.Fragment = ''
    return $builder.Uri.AbsoluteUri
  } catch {
    return $u
  }
}

function Classify-Url {
  param([string] $u)
  $lu = $u.ToLowerInvariant()
  if ($lu -match '^https?://(www\.)?reddit\.com/r/.+/comments/' -or $lu -match '^https?://(www\.)?redd\.it/') { return 'reddit_post' }
  if ($lu -match '^https?://news\.ycombinator\.com/item\?id=\d+') { return 'hn_item' }
  if ($lu -match '^https?://github\.com/[^/]+/[^/]+/pull/\d+') { return 'github_pr' }
  if ($lu -match '^https?://github\.com/[^/]+/[^/]+/releases/tag/') { return 'github_release' }
  if ($lu -match '^https?://github\.com/[^/]+/[^/]+/releases$') { return 'github_releases' }
  if ($lu -match '^https?://devblogs\.microsoft\.com/dotnet/') { return 'ms_devblogs' }
  return 'web'
}

$norm = Normalize-Url -u $Url
$kind = Classify-Url -u $norm

try {
  $resp = Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent } -Uri $norm -TimeoutSec 30
  $html = [string]$resp.Content
  $status = [int]$resp.StatusCode
} catch {
  [pscustomobject]@{
    Url    = $norm
    Type   = $kind
    Error  = $_.Exception.Message
  } | ConvertTo-Json -Depth 8
  exit 0
}

# Canonical URL (best-effort).
$canonical = Try-FirstMatch -Text $html -Pattern '<link[^>]+rel=["'']canonical["''][^>]+href=["''](?<v>[^"''<>]+)["'']'
if ([string]::IsNullOrWhiteSpace($canonical)) { $canonical = $norm }

# Title: prefer og:title, then <title>.
$title = Try-FirstMatch -Text $html -Pattern '<meta[^>]+property=["'']og:title["''][^>]+content=["''](?<v>[^"''<>]+)["'']'
if ([string]::IsNullOrWhiteSpace($title)) { $title = Try-FirstMatch -Text $html -Pattern '<title>\s*(?<v>[^<]+)\s*</title>' }

# Description: og:description or meta description.
$desc = Try-FirstMatch -Text $html -Pattern '<meta[^>]+property=["'']og:description["''][^>]+content=["''](?<v>[^"''<>]+)["'']'
if ([string]::IsNullOrWhiteSpace($desc)) { $desc = Try-FirstMatch -Text $html -Pattern '<meta[^>]+name=["'']description["''][^>]+content=["''](?<v>[^"''<>]+)["'']' }

# Dates: common meta names.
$published = Try-FirstMatch -Text $html -Pattern '<meta[^>]+property=["'']article:published_time["''][^>]+content=["''](?<v>[^"''<>]+)["'']'
if ([string]::IsNullOrWhiteSpace($published)) { $published = Try-FirstMatch -Text $html -Pattern '<meta[^>]+name=["'']published_time["''][^>]+content=["''](?<v>[^"''<>]+)["'']' }
if ([string]::IsNullOrWhiteSpace($published)) { $published = Try-FirstMatch -Text $html -Pattern '<meta[^>]+itemprop=["'']datePublished["''][^>]+content=["''](?<v>[^"''<>]+)["'']' }

$modified = Try-FirstMatch -Text $html -Pattern '<meta[^>]+property=["'']article:modified_time["''][^>]+content=["''](?<v>[^"''<>]+)["'']'
if ([string]::IsNullOrWhiteSpace($modified)) { $modified = Try-FirstMatch -Text $html -Pattern '<meta[^>]+name=["'']modified_time["''][^>]+content=["''](?<v>[^"''<>]+)["'']' }
if ([string]::IsNullOrWhiteSpace($modified)) { $modified = Try-FirstMatch -Text $html -Pattern '<meta[^>]+itemprop=["'']dateModified["''][^>]+content=["''](?<v>[^"''<>]+)["'']' }

[pscustomobject]@{
  Url       = $norm
  Canonical = $canonical
  Type      = $kind
  Status    = $status
  Title     = $title
  Summary   = $desc
  Published = $published
  Modified  = $modified
} | ConvertTo-Json -Depth 8


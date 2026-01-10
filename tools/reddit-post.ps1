param(
  [Parameter(Mandatory = $true)]
  [string] $Url
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

function Normalize-RedditJsonUrl {
  param([string] $InputUrl)

  $u = $InputUrl.Trim()
  if ($u -notmatch '^https?://') {
    $u = 'https://www.reddit.com' + (if ($u.StartsWith('/')) { $u } else { '/' + $u })
  }

  # Ensure trailing slash so "....json" appends correctly.
  if (-not $u.EndsWith('/')) { $u += '/' }

  return ($u + '.json?raw_json=1')
}

function Extract-Links {
  param([string] $Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }

  function Clean-Link {
    param([string] $Link)
    if ([string]::IsNullOrWhiteSpace($Link)) { return $null }

    $l = $Link.Trim()
    # If a bare-url regex accidentally grabbed a Markdown fragment like:
    # https://a](https://b
    # keep the first URL part; the real target URL is already extracted via the Markdown regex.
    if ($l -match '\]\(https?://') {
      $l = $l.Split('](')[0]
    }
    # Strip common wrappers/punctuation that show up in Markdown and prose.
    $l = $l.TrimStart('(').TrimEnd(')', ']', '.', ',', ';', ':', '"', '''')
    return $l
  }

  $links = @()

  # Markdown-style links: [text](https://example)
  $md = [regex]::Matches($Text, '\[[^\]]*\]\((https?://[^)\s]+)\)', 'IgnoreCase') | ForEach-Object { $_.Groups[1].Value }
  $links += $md

  # Bare links.
  $bare = [regex]::Matches($Text, 'https?://[^\s\]\)>\"]+', 'IgnoreCase') | ForEach-Object { $_.Value }
  $links += $bare

  return @(
    $links |
      ForEach-Object { Clean-Link $_ } |
      Where-Object { $_ } |
      Select-Object -Unique
  )
}

$JsonUrl = Normalize-RedditJsonUrl -InputUrl $Url
$Post = (Invoke-RestMethod -Headers @{ 'User-Agent' = $UserAgent } -Uri $JsonUrl -TimeoutSec 30)[0].data.children[0].data

$CreatedUtc = [DateTimeOffset]::FromUnixTimeSeconds([int64]([double]$Post.created_utc)).UtcDateTime.ToString('s') + 'Z'

Write-Host ("title: {0}" -f $Post.title)
Write-Host ("created_utc: {0}" -f $CreatedUtc)
Write-Host ("permalink: https://www.reddit.com{0}" -f $Post.permalink)
Write-Host ("url: {0}" -f $Post.url)
Write-Host ("is_self: {0}" -f $Post.is_self)

if (-not [string]::IsNullOrWhiteSpace([string]$Post.selftext)) {
  Write-Host ''
  Write-Host 'selftext:'
  Write-Host $Post.selftext
}

$Links = Extract-Links -Text ([string]$Post.selftext)
if ($Links.Count -gt 0) {
  Write-Host ''
  Write-Host 'links:'
  $Links | ForEach-Object { Write-Host ("- {0}" -f $_) }
}


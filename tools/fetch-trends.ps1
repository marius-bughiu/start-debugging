$ErrorActionPreference = 'Stop'

$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'
$Since = (Get-Date).AddDays(-2)

$Urls = @(
  'https://devblogs.microsoft.com/dotnet/feed/',
  'https://github.com/dotnet/runtime/releases.atom',
  'https://github.com/dotnet/sdk/releases.atom',
  'https://github.com/dotnet/aspnetcore/releases.atom',
  'https://github.com/flutter/flutter/releases.atom',
  'https://github.com/dart-lang/sdk/releases.atom',

  # Community / real-time (RSS/Atom)
  'https://www.reddit.com/r/dotnet/new/.rss',
  'https://www.reddit.com/r/csharp/new/.rss',
  'https://www.reddit.com/r/FlutterDev/new/.rss',
  'https://hnrss.org/frontpage?count=50'
)

function Get-LinkHref {
  param([Parameter(ValueFromPipeline=$true)] $LinkNode)

  if ($null -eq $LinkNode) { return $null }
  if ($LinkNode -is [System.Array]) { $LinkNode = $LinkNode | Select-Object -First 1 }

  if ($null -ne $LinkNode.href) { return [string]$LinkNode.href }
  return [string]$LinkNode
}

function Write-Entry {
  param(
    [datetime] $Date,
    [string] $Title,
    [string] $Link,
    [string] $Source
  )

  # Stable, grep-friendly format:
  # 2026-01-10T12:34:56 | Source | Title | Link
  '{0} | {1} | {2} | {3}' -f $Date.ToString('s'), $Source, ($Title.Trim()), $Link
}

foreach ($Url in $Urls) {
  Write-Host ''
  Write-Host ("=== $Url ===")

  try {
    $Resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers @{ 'User-Agent' = $UserAgent } -TimeoutSec 30
    [xml]$Xml = $Resp.Content

    if ($Xml.rss -and $Xml.rss.channel -and $Xml.rss.channel.item) {
      foreach ($Item in $Xml.rss.channel.item) {
        $Date = Get-Date $Item.pubDate
        if ($Date -ge $Since) {
          Write-Entry -Date $Date -Title ([string]$Item.title) -Link ([string]$Item.link) -Source $Url
        }
      }
      continue
    }

    if ($Xml.feed -and $Xml.feed.entry) {
      foreach ($Entry in $Xml.feed.entry) {
        $DateString = [string]$Entry.updated
        if ([string]::IsNullOrWhiteSpace($DateString)) { $DateString = [string]$Entry.published }
        $Date = Get-Date $DateString
        if ($Date -ge $Since) {
          $Link = $Entry.link | Get-LinkHref
          Write-Entry -Date $Date -Title ([string]$Entry.title) -Link $Link -Source $Url
        }
      }
      continue
    }

    Write-Host 'Unrecognized feed format.'
  }
  catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message)
  }
}



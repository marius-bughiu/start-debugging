param(
  [Parameter(Mandatory = $true)]
  [string] $IdOrUrl,
  [switch] $Json
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

function Extract-Id {
  param([string] $Value)

  $v = $Value.Trim()
  if ($v -match '^\d+$') { return [int64]$v }

  # news.ycombinator.com/item?id=123
  if ($v -match 'news\.ycombinator\.com/item\?id=(\d+)') { return [int64]$Matches[1] }

  # Sometimes the id appears as ...?id=123&...
  if ($v -match '[\?&]id=(\d+)') { return [int64]$Matches[1] }

  return $null
}

$id = Extract-Id -Value $IdOrUrl
if ($null -eq $id) { throw "Could not extract HN item id from: $IdOrUrl" }

$ApiUrl = "https://hn.algolia.com/api/v1/items/$id"
try {
  $Item = Invoke-RestMethod -Headers @{ 'User-Agent' = $UserAgent } -Uri $ApiUrl -TimeoutSec 30
} catch {
  if ($Json) {
    [pscustomobject]@{
      Id     = $id
      ApiUrl = $ApiUrl
      Error  = $_.Exception.Message
    } | ConvertTo-Json -Depth 8
    exit 0
  } else {
    Write-Host ("ERROR: could not fetch HN item {0}. Check the id/url." -f $id)
    Write-Host ("api: {0}" -f $ApiUrl)
    Write-Host ("details: {0}" -f $_.Exception.Message)
    exit 1
  }
}

$target = $Item.url
if ([string]::IsNullOrWhiteSpace($target)) {
  $target = "https://news.ycombinator.com/item?id=$id"
}

if ($Json) {
  [pscustomobject]@{
    Id        = $id
    Title     = [string]$Item.title
    Author    = [string]$Item.author
    CreatedAt = [string]$Item.created_at
    Points    = [int]$Item.points
    Comments  = [int](($Item.children | Measure-Object).Count)
    Url       = [string]$target
    HnUrl     = ("https://news.ycombinator.com/item?id={0}" -f $id)
  } | ConvertTo-Json -Depth 8
  exit 0
}

Write-Host ("id: {0}" -f $id)
Write-Host ("title: {0}" -f $Item.title)
Write-Host ("author: {0}" -f $Item.author)
Write-Host ("created_at: {0}" -f $Item.created_at)
Write-Host ("points: {0}" -f $Item.points)
Write-Host ("comments: {0}" -f ($Item.children | Measure-Object).Count)
Write-Host ("url: {0}" -f $target)
Write-Host ("hn_url: https://news.ycombinator.com/item?id={0}" -f $id)


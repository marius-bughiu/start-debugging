param(
  [Parameter(Mandatory = $true)]
  [string] $Repo, # e.g. "dotnet/sdk"

  [string] $Tag,
  [switch] $Body,
  [switch] $Json
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

if ([string]::IsNullOrWhiteSpace($Tag)) {
  $ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"
} else {
  $ApiUrl = "https://api.github.com/repos/$Repo/releases/tags/$Tag"
}

try {
  $Rel = Invoke-RestMethod -Headers @{ 'User-Agent' = $UserAgent } -Uri $ApiUrl -TimeoutSec 30
} catch {
  if ($Json) {
    [pscustomobject]@{
      Repo  = $Repo
      Tag   = $Tag
      Error = $_.Exception.Message
    } | ConvertTo-Json -Depth 8
    exit 0
  } else {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message)
    exit 1
  }
}

if ($Json) {
  [pscustomobject]@{
    Repo        = $Repo
    Tag         = [string]$Rel.tag_name
    Name        = [string]$Rel.name
    Draft       = [bool]$Rel.draft
    Prerelease  = [bool]$Rel.prerelease
    PublishedAt = [string]$Rel.published_at
    Url         = [string]$Rel.html_url
    Assets      = @($Rel.assets | ForEach-Object { [pscustomobject]@{ Name = $_.name; Url = $_.browser_download_url } })
    Body        = (if ($Body) { [string]$Rel.body } else { $null })
  } | ConvertTo-Json -Depth 10
  exit 0
}

Write-Host ("repo: {0}" -f $Repo)
Write-Host ("tag: {0}" -f $Rel.tag_name)
Write-Host ("name: {0}" -f $Rel.name)
Write-Host ("draft: {0}" -f $Rel.draft)
Write-Host ("prerelease: {0}" -f $Rel.prerelease)
Write-Host ("published_at: {0}" -f $Rel.published_at)
Write-Host ("html_url: {0}" -f $Rel.html_url)

if ($Rel.assets -and $Rel.assets.Count -gt 0) {
  Write-Host ""
  Write-Host "assets:"
  $Rel.assets | ForEach-Object {
    Write-Host ("- {0} ({1})" -f $_.name, $_.browser_download_url)
  }
}

if ($Body -and -not [string]::IsNullOrWhiteSpace([string]$Rel.body)) {
  Write-Host ""
  Write-Host "body:"
  Write-Host $Rel.body
}


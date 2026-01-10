param(
  [Parameter(Mandatory = $true)]
  [string] $Package,
  [switch] $Json
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

$ApiUrl = "https://pub.dev/api/packages/$Package"
$Resp = Invoke-RestMethod -Headers @{ 'User-Agent' = $UserAgent } -Uri $ApiUrl -TimeoutSec 30

$Repo = $Resp.latest.pubspec.repository
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = $Resp.latest.pubspec.homepage }

if ($Json) {
  [pscustomobject]@{
    Package        = [string]$Resp.name
    LatestVersion  = [string]$Resp.latest.version
    LatestPublished= [string]$Resp.latest.published
    Repository     = (if (-not [string]::IsNullOrWhiteSpace($Repo)) { [string]$Repo } else { $null })
  } | ConvertTo-Json -Depth 8
  exit 0
}

Write-Host ("package: {0}" -f $Resp.name)
Write-Host ("latest_version: {0}" -f $Resp.latest.version)
Write-Host ("latest_published: {0}" -f $Resp.latest.published)

if (-not [string]::IsNullOrWhiteSpace($Repo)) {
  Write-Host ("repository: {0}" -f $Repo)
}


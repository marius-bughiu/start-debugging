param(
  [Parameter(Mandatory = $true)]
  [string] $Repo, # e.g. "dotnet/sdk"

  [Parameter(Mandatory = $true)]
  [int] $Number
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

$ApiUrl = "https://api.github.com/repos/$Repo/pulls/$Number"
$Pr = Invoke-RestMethod -Headers @{ 'User-Agent' = $UserAgent } -Uri $ApiUrl -TimeoutSec 30

Write-Host ("repo: {0}" -f $Repo)
Write-Host ("number: {0}" -f $Number)
Write-Host ("title: {0}" -f $Pr.title)
Write-Host ("state: {0}" -f $Pr.state)
Write-Host ("created_at: {0}" -f $Pr.created_at)
Write-Host ("updated_at: {0}" -f $Pr.updated_at)
Write-Host ("html_url: {0}" -f $Pr.html_url)

if (-not [string]::IsNullOrWhiteSpace([string]$Pr.body)) {
  Write-Host ''
  Write-Host 'body:'
  Write-Host $Pr.body
}


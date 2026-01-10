param(
  [string[]] $Urls = @(
    'https://startdebugging.net/robots.txt',
    'https://startdebugging.net/sitemap.xml',
    'https://startdebugging.net/sitemap_index.xml'
  )
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

foreach ($Url in $Urls) {
  Write-Host ""
  Write-Host "=== $Url ==="

  try {
    $Resp = Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent } -Uri $Url -TimeoutSec 30
    Write-Host ("status {0}" -f [int]$Resp.StatusCode)
    $Content = [string]$Resp.Content
    Write-Host ("len {0}" -f $Content.Length)
    if ($Content.Length -gt 600) {
      $Content.Substring(0, 600)
    } else {
      $Content
    }
  }
  catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message)
  }
}



param(
  [string[]] $Urls = @(
    'https://startdebugging.net/robots.txt',
    'https://startdebugging.net/sitemap.xml',
    'https://startdebugging.net/sitemap_index.xml'
  ),
  [switch] $Json
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

if ($Json) { $out = @() }

foreach ($Url in $Urls) {
  if (-not $Json) {
    Write-Host ""
    Write-Host "=== $Url ==="
  }

  try {
    $Resp = Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent } -Uri $Url -TimeoutSec 30
    $Content = [string]$Resp.Content
    if ($Json) {
      $out += [pscustomobject]@{
        Url        = $Url
        StatusCode = [int]$Resp.StatusCode
        Length     = $Content.Length
        Head       = (if ($Content.Length -gt 600) { $Content.Substring(0, 600) } else { $Content })
      }
    } else {
      Write-Host ("status {0}" -f [int]$Resp.StatusCode)
      Write-Host ("len {0}" -f $Content.Length)
      if ($Content.Length -gt 600) {
        $Content.Substring(0, 600)
      } else {
        $Content
      }
    }
  }
  catch {
    if ($Json) {
      $out += [pscustomobject]@{
        Url   = $Url
        Error = $_.Exception.Message
      }
    } else {
      Write-Host ("ERROR: {0}" -f $_.Exception.Message)
    }
  }
}

if ($Json) {
  $out | ConvertTo-Json -Depth 6
}



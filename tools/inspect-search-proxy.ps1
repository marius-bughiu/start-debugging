param(
  [Parameter(Mandatory = $true)]
  [string] $Query,

  [ValidateSet('google','bing')]
  [string] $Engine = 'google'
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

$Encoded = [uri]::EscapeDataString($Query)

if ($Engine -eq 'google') {
  $Url = "https://r.jina.ai/http://www.google.com/search?hl=en&num=5&pws=0&q=$Encoded"
} else {
  $Url = "https://r.jina.ai/http://www.bing.com/search?q=$Encoded&count=5"
}

Write-Host "ENGINE: $Engine"
Write-Host "URL: $Url"

try {
  $Resp = Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent } -Uri $Url -TimeoutSec 30
  $Content = [string]$Resp.Content
  Write-Host ("status {0}" -f [int]$Resp.StatusCode)
  Write-Host ("len {0}" -f $Content.Length)
  $Content.Substring(0, [Math]::Min(800, $Content.Length))
}
catch {
  Write-Host ("ERROR: {0}" -f $_.Exception.Message)
}



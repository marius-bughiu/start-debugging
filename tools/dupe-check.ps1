param(
  [Parameter(Mandatory = $true)]
  [string] $Query,

  [switch] $Json
)

$ErrorActionPreference = 'Stop'

$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

function Invoke-SearchText {
  param([string] $Url)

  try {
    (Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers @{ 'User-Agent' = $UserAgent } -TimeoutSec 30).Content
  }
  catch {
    return $null
  }
}

function Extract-StartDebuggingUrls {
  param([string] $Text)

  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }

  # Keep it simple: any URL containing startdebugging.net.
  # Avoid single-quote escaping issues by not matching `'` explicitly.
  $pattern = 'https?://[^\\s"]*startdebugging\\.net[^\\s"]*'
  $matches = [regex]::Matches($Text, $pattern, 'IgnoreCase') |
    ForEach-Object { $_.Value } |
    Select-Object -Unique

  return @($matches)
}

$Encoded = [uri]::EscapeDataString($Query)

# Preferred: Google through r.jina.ai to bypass consent pages in automated environments.
$GoogleUrl = "https://r.jina.ai/http://www.google.com/search?hl=en&num=10&pws=0&q=$Encoded"
$Text = Invoke-SearchText -Url $GoogleUrl
$Urls = Extract-StartDebuggingUrls -Text $Text

if ($Urls.Count -gt 0) {
  if ($Json) {
    [pscustomobject]@{
      Query  = $Query
      Engine = 'google (via r.jina.ai)'
      Urls   = @($Urls)
    } | ConvertTo-Json -Depth 6
  } else {
    Write-Host "QUERY: $Query"
    Write-Host "ENGINE: google (via r.jina.ai)"
    $Urls | ForEach-Object { Write-Host $_ }
  }
  exit 0
}

# Fallback: Bing (sometimes works when Google blocks).
$BingUrl = "https://r.jina.ai/http://www.bing.com/search?q=$Encoded&count=10"
$Text = Invoke-SearchText -Url $BingUrl
$Urls = Extract-StartDebuggingUrls -Text $Text

if ($Json) {
  $engine = 'google/bing (no startdebugging.net results found)'
  if ($Urls.Count -gt 0) { $engine = 'bing (via r.jina.ai)' }

  [pscustomobject]@{
    Query  = $Query
    Engine = $engine
    Urls   = @($Urls)
  } | ConvertTo-Json -Depth 6
} else {
  Write-Host "QUERY: $Query"
  if ($Urls.Count -gt 0) {
    Write-Host "ENGINE: bing (via r.jina.ai)"
  } else {
    Write-Host "ENGINE: google/bing (no startdebugging.net results found)"
  }

  $Urls | ForEach-Object { Write-Host $_ }
}



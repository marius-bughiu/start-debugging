param(
  [Parameter(Mandatory = $true)]
  [string] $Term,

  [switch] $Json
)

$ErrorActionPreference = 'Stop'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

$Encoded = [uri]::EscapeDataString($Term)
$Url = "https://startdebugging.net/?s=$Encoded"

try {
  $Resp = Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $UserAgent } -Uri $Url -TimeoutSec 30
  $Html = [string]$Resp.Content
  $Head = $Html.Substring(0, [Math]::Min(500, $Html.Length)).Replace("`r", " ").Replace("`n", " ")

  # Prefer result links (WordPress typically marks them as rel="bookmark").
  $bookmarkPattern = 'rel=["'']bookmark["''][^>]*href=["'']([^"''<>\\s]+)["'']|href=["'']([^"''<>\\s]+)["''][^>]*rel=["'']bookmark["'']'
  $raw = [regex]::Matches($Html, $bookmarkPattern, 'IgnoreCase') | ForEach-Object {
    if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
  }

  $links = @($raw) | ForEach-Object {
      $l = $_
      if ($l.StartsWith('//')) { return $null } # external, scheme-relative
      if ($l.StartsWith('/')) { return ('https://startdebugging.net' + $l) }
      return $l
    } |
    Where-Object { $_ } |
    Where-Object { $_ -match '^https?://startdebugging\\.net/' } |
    Where-Object { $_ -notmatch '\\?s=' } |
    Select-Object -Unique

  if ($links.Count -eq 0) {
    if ($Json) {
      [pscustomobject]@{
        Term       = $Term
        Url        = $Url
        StatusCode = [int]$Resp.StatusCode
        HtmlLength = $Html.Length
        Head       = $Head
        Urls       = @()
      } | ConvertTo-Json -Depth 6
    } else {
      Write-Host "URL: $Url"
      Write-Host ("status {0}" -f [int]$Resp.StatusCode)
      Write-Host ("len {0}" -f $Html.Length)
      Write-Host ("head: " + $Head)
      Write-Host "RESULTS: (no links found on the search page)"
    }
  } else {
    if ($Json) {
      [pscustomobject]@{
        Term       = $Term
        Url        = $Url
        StatusCode = [int]$Resp.StatusCode
        HtmlLength = $Html.Length
        Head       = $Head
        Urls       = @($links)
      } | ConvertTo-Json -Depth 6
    } else {
      Write-Host "URL: $Url"
      Write-Host ("status {0}" -f [int]$Resp.StatusCode)
      Write-Host ("len {0}" -f $Html.Length)
      Write-Host ("head: " + $Head)
      Write-Host "RESULTS:"
      $links | ForEach-Object { Write-Host $_ }
    }
  }
}
catch {
  if ($Json) {
    [pscustomobject]@{
      Term  = $Term
      Url   = $Url
      Error = $_.Exception.Message
      Urls  = @()
    } | ConvertTo-Json -Depth 6
  } else {
    Write-Host "URL: $Url"
    Write-Host ("ERROR: {0}" -f $_.Exception.Message)
  }
}



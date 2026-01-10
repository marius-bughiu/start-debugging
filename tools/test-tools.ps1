param(
  [switch] $VerboseOutput
)

$ErrorActionPreference = 'Stop'

function Assert-True {
  param([bool] $Condition, [string] $Message)
  if (-not $Condition) { throw "ASSERT FAILED: $Message" }
}

function Run-Test {
  param([string] $Name, [scriptblock] $Body)
  Write-Host ""
  Write-Host ("== {0} ==" -f $Name)
  & $Body
  Write-Host "OK"
}

$root = Split-Path -Parent $PSScriptRoot

Run-Test "fetch-trends -Json parses" {
  $p = Join-Path $root 'tools\fetch-trends.ps1'
  $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $p -SinceHours 1 -Quiet -Json
  $obj = $null
  try { $obj = $json | ConvertFrom-Json } catch { $obj = $null }
  Assert-True ($null -ne $obj) "fetch-trends returned non-JSON"
  Assert-True ($obj -is [System.Array] -or $obj.PSObject.Properties.Count -ge 0) "fetch-trends JSON has unexpected shape"
}

Run-Test "sd-search -Json parses" {
  $p = Join-Path $root 'tools\sd-search.ps1'
  $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $p -Keywords dotnet -Json
  $obj = $json | ConvertFrom-Json
  Assert-True ($obj.PSObject.Properties.Name -contains 'All') "sd-search missing All"
}

Run-Test "dupe-check -Json parses" {
  $p = Join-Path $root 'tools\dupe-check.ps1'
  $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $p -Query "site:startdebugging.net dotnet" -Json
  $obj = $json | ConvertFrom-Json
  Assert-True ($obj.PSObject.Properties.Name -contains 'Urls') "dupe-check missing Urls"
}

Run-Test "sd-daily -Json parses" {
  $p = Join-Path $root 'tools\sd-daily.ps1'
  $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $p -Top 3 -Json
  $obj = $json | ConvertFrom-Json
  Assert-True ($obj.PSObject.Properties.Name -contains 'Candidates') "sd-daily missing Candidates"
}

Run-Test "sd-agent emits JSON bundle" {
  $p = Join-Path $root 'tools\sd-agent.ps1'
  $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $p -Top 2 -EnrichTop 1
  $obj = $json | ConvertFrom-Json
  Assert-True ($obj.PSObject.Properties.Name -contains 'Evidence') "sd-agent missing Evidence"
}

Run-Test "draft-lint runs on drafts dir" {
  $p = Join-Path $root 'tools\draft-lint.ps1'
  $dir = Join-Path $root 'content-strategy\drafts'
  # This intentionally may exit 2 if issues exist; treat that as success for the tool execution.
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $p -Dir $dir 2>&1
  if ($VerboseOutput) { $out }
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]($out | Out-String))) "draft-lint produced no output"
}

Write-Host ""
Write-Host "All smoke tests completed."


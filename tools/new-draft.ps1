param(
  [Parameter(Mandatory = $true)]
  [string] $Title,

  [string] $Slug,
  [string[]] $Sources = @(),
  [string] $DraftsDir = 'content-strategy/drafts',
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

function Slugify {
  param([string] $Text)

  $t = $Text.ToLowerInvariant()
  $t = $t -replace '[^a-z0-9]+', '-'
  $t = $t.Trim('-')
  # Avoid absurdly long filenames.
  if ($t.Length -gt 80) { $t = $t.Substring(0, 80).Trim('-') }
  return $t
}

$date = (Get-Date).ToString('yyyy-MM-dd')

if ([string]::IsNullOrWhiteSpace($Slug)) {
  $Slug = Slugify -Text $Title
}

$root = Split-Path -Parent $PSScriptRoot
$draftDirPath = Join-Path $root $DraftsDir
if (-not (Test-Path $draftDirPath)) {
  New-Item -ItemType Directory -Path $draftDirPath | Out-Null
}

$fileName = "$date-$Slug.md"
$path = Join-Path $draftDirPath $fileName

if ((Test-Path $path) -and -not $Force) {
  throw "Draft already exists: $path (use -Force to overwrite)"
}

$srcBlock = ''
if ($Sources.Count -gt 0) {
  $srcBlock = "Sources:`r`n" + (($Sources | Where-Object { $_ } | ForEach-Object { '- ' + $_ }) -join "`r`n") + "`r`n`r`n"
}

$content = @"
# $Title

$srcBlock## What changed (anchor to the trigger)

Write 2-3 sentences that start directly with the context/news. No “Introduction” header.

## The sharp takeaway

Explain the practical implication (behavior, perf, tooling, breaking change).

## The code (minimal, runnable)

```text
TODO: add one focused example (C#/PowerShell/Dart).
```

## Edge cases / traps

- TODO

Further reading: TODO (official docs/PR/release notes)
"@

Set-Content -Path $path -Value $content -Encoding UTF8
Write-Host "Created: $path"


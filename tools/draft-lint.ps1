param(
  [Parameter(Mandatory = $true, ParameterSetName = 'File')]
  [string] $Path,

  [Parameter(Mandatory = $true, ParameterSetName = 'Dir')]
  [string] $Dir,

  [int] $MinWords = 300,
  [int] $MaxWords = 600,
  [switch] $Json
)

$ErrorActionPreference = 'Stop'

function Get-WordsCount {
  param([string] $Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return 0 }
  $words = (($Text -replace '\s+', ' ').Trim().Split(' ')) | Where-Object { $_ -and $_.Trim() -ne '' }
  return $words.Count
}

function Lint-One {
  param([string] $FilePath)

  $raw = Get-Content -LiteralPath $FilePath -Raw
  $issues = @()

  # 1) Em dash check (strict).
  if ($raw -match '—') {
    $issues += [pscustomobject]@{ Code = 'EM_DASH'; Message = 'Contains an em dash (—).'; Hint = 'Replace with commas, colons, parentheses, or "--".' }
  }

  # 2) Forbidden generic headers.
  $forbidden = @('Introduction','Conclusion','The Problem','The Solution','Code Example')
  foreach ($h in $forbidden) {
    if ($raw -match ("(?m)^\s*#{1,6}\s+" + [regex]::Escape($h) + "\s*$")) {
      $issues += [pscustomobject]@{ Code = 'FORBIDDEN_HEADER'; Message = ("Uses forbidden header: '{0}'." -f $h); Hint = 'Use descriptive, topic-specific headers.' }
    }
  }

  # 3) Word count (rough).
  $wc = Get-WordsCount -Text $raw
  if ($wc -lt $MinWords -or $wc -gt $MaxWords) {
    $issues += [pscustomobject]@{
      Code    = 'WORDCOUNT'
      Message = ("Word count {0} is outside target range [{1}, {2}]." -f $wc, $MinWords, $MaxWords)
      Hint    = 'Aim for 300-600 words unless the post intentionally breaks the rule.'
    }
  }

  # 4) Has at least one fenced code block.
  if ($raw -notmatch '(?ms)```.+?```') {
    $issues += [pscustomobject]@{ Code = 'NO_CODE_BLOCK'; Message = 'No fenced code block found.'; Hint = 'Add at least one focused code example.' }
  }

  # 5) Mentions at least one version-ish token.
  # Allow: ".NET 9", "C# 14", "Flutter 3.x", "Dart 3.12", "v9.0.0", "3.12.0-12.0.dev"
  $versionish = @(
    '\.net\s+\d+',
    'c#\s+\d+',
    'flutter\s+\d+(\.\w+)?',
    'dart\s+\d+(\.\d+)?',
    '\bv?\d+(\.\d+){1,3}([\-\.](preview|rc|dev))?\w*\b'
  )
  $hasVersion = $false
  foreach ($p in $versionish) {
    if ($raw.ToLowerInvariant() -match $p) { $hasVersion = $true; break }
  }
  if (-not $hasVersion) {
    $issues += [pscustomobject]@{ Code = 'NO_VERSION'; Message = 'No obvious version mention found.'; Hint = 'Mention explicit versions (e.g., .NET 10, Flutter 3.x).' }
  }

  [pscustomobject]@{
    File      = $FilePath
    WordCount = $wc
    Issues    = $issues
    Ok        = (($issues | Measure-Object).Count -eq 0)
  }
}

function Resolve-Inputs {
  if ($PSCmdlet.ParameterSetName -eq 'File') {
    if (-not (Test-Path -LiteralPath $Path)) { throw "File not found: $Path" }
    return @((Resolve-Path -LiteralPath $Path).Path)
  }
  if (-not (Test-Path -LiteralPath $Dir)) { throw "Dir not found: $Dir" }
  return @(Get-ChildItem -LiteralPath $Dir -Filter '*.md' -File | ForEach-Object { $_.FullName })
}

try {
  $files = Resolve-Inputs
  $results = @()
  foreach ($f in $files) { $results += (Lint-One -FilePath $f) }
} catch {
  Write-Error ("draft-lint failed: {0}" -f $_.Exception.ToString())
  exit 1
}

if ($Json) {
  [pscustomobject]@{
    MinWords = $MinWords
    MaxWords = $MaxWords
    Results  = $results
  } | ConvertTo-Json -Depth 10
} else {
  foreach ($r in $results) {
    if ($r.Ok) {
      Write-Host ("OK  {0} ({1} words)" -f $r.File, $r.WordCount)
      continue
    }
    Write-Host ("FAIL {0} ({1} words)" -f $r.File, $r.WordCount)
    $r.Issues | ForEach-Object {
      Write-Host ("  - {0}: {1}" -f $_.Code, $_.Message)
    }
  }
}

# Exit non-zero if any failures (useful for CI / gating).
if (($results | Where-Object { -not $_.Ok } | Measure-Object).Count -gt 0) {
  exit 2
}


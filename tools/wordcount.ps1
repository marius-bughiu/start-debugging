$ErrorActionPreference = 'Stop'

$Files = @($args)
if ($Files.Count -eq 0) {
  throw "Usage: powershell -File tools\\wordcount.ps1 <file1> <file2> ..."
}

foreach ($f in $Files) {
  $raw = Get-Content $f -Raw
  $words = (($raw -replace '\s+', ' ').Trim().Split(' ')).Count
  Write-Host ("{0} -> {1} words" -f $f, $words)
}



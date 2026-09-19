# Runs the simulations in headless Chrome.
#
#   powershell -File tools\sim\run.ps1 collector
#   powershell -File tools\sim\run.ps1 ingest
#   powershell -File tools\sim\run.ps1 parse
#   powershell -File tools\sim\run.ps1 all
#
# Exits non-zero if any check fails, so it works in a hook or in CI.
param([string]$Suite = 'all')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $env:TEMP 'instalurk-sim'
if (-not (Test-Path $work)) { New-Item -ItemType Directory -Force $work | Out-Null }

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'No Chrome or Edge found. Install one, or edit tools/sim/run.ps1.' }

function Invoke-Page([string]$Path) {
  $url = 'file:///' + ($Path -replace '\\', '/')
  $dom = Join-Path $work 'dom.txt'
  $err = Join-Path $work 'err.txt'
  $a = @(
    '--headless=new', '--disable-gpu', '--no-sandbox',
    "--user-data-dir=$work\profile", '--virtual-time-budget=900000',
    '--dump-dom', $url
  )
  Start-Process -FilePath $chrome -ArgumentList $a `
    -RedirectStandardOutput $dom -RedirectStandardError $err -Wait -NoNewWindow
  # ReadAllText, not Get-Content: PowerShell 5.1 would decode the dumped DOM as
  # ANSI and turn every non-ASCII character in the output into mojibake.
  $html = [System.IO.File]::ReadAllText($dom)
  $m = [regex]::Match($html, '(?s)<pre id="out">(.*?)</pre>')
  if (-not $m.Success) { throw "No output from $Path" }
  [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
}

$failed = $false

function Invoke-Suite([string]$Name, [string]$Page) {
  Write-Output ''
  Write-Output "=== $Name ==="
  $text = Invoke-Page $Page
  Write-Output $text
  if ($text -notmatch 'DONE') { $script:failed = $true; Write-Output "!! $Name did not finish" }
  if ($text -match 'FAIL|PARSE ERROR|CHECK\(S\) FAILED|ODD!|CONTROL BYTES') { $script:failed = $true }
}

if ($Suite -eq 'parse' -or $Suite -eq 'all') {
  Invoke-Suite 'parse' (& (Join-Path $here 'build-parse.ps1') -OutDir $work | Select-Object -Last 1)
}
if ($Suite -eq 'collector' -or $Suite -eq 'all') {
  Invoke-Suite 'collector' (& (Join-Path $here 'build.ps1') -OutDir $work | Select-Object -Last 1)
}
if ($Suite -eq 'ingest' -or $Suite -eq 'all') {
  Invoke-Suite 'ingest' (& (Join-Path $here 'build-ingest.ps1') -OutDir $work | Select-Object -Last 1)
}

Write-Output ''
if ($failed) { Write-Output 'SIM FAILED'; exit 1 }
Write-Output 'SIM PASSED'

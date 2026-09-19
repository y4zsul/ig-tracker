# Lifts the named diffing functions out of background.js by brace matching and
# evals them against stubs. Asserted by name, so a rename breaks this loudly.
param([string]$OutDir)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'instalurk-sim' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }

$src = [System.IO.File]::ReadAllText((Join-Path $repo 'src\background.js'))

function Get-Fn([string]$text, [string]$name) {
  $start = $text.IndexOf("`nfunction $name(")
  if ($start -lt 0) { throw "function $name not found in background.js" }
  $start++
  $i = $text.IndexOf('{', $start)
  $depth = 0
  for ($j = $i; $j -lt $text.Length; $j++) {
    $c = $text[$j]
    if ($c -eq '{') { $depth++ }
    elseif ($c -eq '}') { $depth--; if ($depth -eq 0) { return $text.Substring($start, $j - $start + 1) } }
  }
  throw "unbalanced braces in $name"
}

$wanted = @('captureTolerance', 'snapshotReliable', 'ingestSnapshot', 'trackSummary', 'displayName')
$code = "const looksNumeric = (s) => !s || /^\d+$/.test(String(s));`r`n`r`n" +
        (($wanted | ForEach-Object { Get-Fn $src $_ }) -join "`r`n`r`n")

# Guard against testing a stale copy of the logic.
foreach ($marker in @('snapshotReliable(prev)', 'prevDepth', 'run.scope')) {
  if (-not $code.Contains($marker)) { throw "extract is missing '$marker' - build-ingest.ps1 is out of date" }
}

$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($code))
$cases = [System.IO.File]::ReadAllText((Join-Path $here 'ingest.js'))

$page = @"
<pre id="out"></pre>
<script>
const dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
window.__CODE__ = "$b64";
</script>
<script>
$cases
</script>
"@

Set-Content (Join-Path $OutDir 'ingest.html') $page -Encoding utf8
Join-Path $OutDir 'ingest.html'

# Splices the SHIPPED collector into a harness page alongside the mock.
#
# Two substitutions, both asserted. If either stops matching, this throws
# rather than quietly testing something that is not the product.
param([string]$OutDir)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'instalurk-sim' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }

$src = [System.IO.File]::ReadAllText((Join-Path $repo 'src\interceptor.js'))

# post() -> local sink. Messages posted under a file:// origin are never
# delivered while --virtual-time-budget is driving the clock.
$postOld = @'
  function post(message) {
    try {
      window.postMessage({ [OUT]: 1, ...message }, window.location.origin);
    } catch (_) {}
  }
'@
$postNew = @'
  function post(message) {
    try { window.__sink(message); } catch (_) {}
  }
'@
if (-not $src.Contains($postOld)) { throw 'post() no longer matches - update tools/sim/build.ps1' }
$src = $src.Replace($postOld, $postNew)

# Expose collect() so the runner can call it without the postMessage hop.
$annOld = '  const announce = () =>'
if (-not $src.Contains($annOld)) { throw 'announce() no longer matches - update tools/sim/build.ps1' }
$src = $src.Replace($annOld, "  window.__collect = collect;`r`n" + $annOld)

$mock = [System.IO.File]::ReadAllText((Join-Path $here 'mock.js'))
$cases = [System.IO.File]::ReadAllText((Join-Path $here 'collector.js'))

$page = @"
<pre id="out">running</pre>
<script>
$mock
</script>
<script>
$src
</script>
<script>
$cases
</script>
"@

Set-Content (Join-Path $OutDir 'collector.html') $page -Encoding utf8
Join-Path $OutDir 'collector.html'

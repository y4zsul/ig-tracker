# Prints download counts for every published release asset.
#
# Public repo, so no token and no auth. GitHub counts these itself; nothing
# is added to the extension and nothing phones home.
#
#   powershell -File tools\downloads.ps1

$ErrorActionPreference = 'Stop'
$repo = 'y4zsul/ig-tracker'

# TLS 1.2 is not the default in Windows PowerShell 5.1 and api.github.com
# refuses anything older.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases" `
    -Headers @{ 'User-Agent' = 'instalurk-downloads'; 'Accept' = 'application/vnd.github+json' }
} catch {
  Write-Host "Could not reach the GitHub API: $($_.Exception.Message)"
  exit 1
}

if (-not $releases -or $releases.Count -eq 0) {
  Write-Host "No releases published yet, so there is nothing to count."
  Write-Host "Tag a version, then attach download/instalurk.zip to it on GitHub."
  exit 0
}

$total = 0
"{0,-12} {1,-26} {2,8}  {3}" -f 'RELEASE', 'ASSET', 'DOWNLOADS', 'PUBLISHED'
foreach ($r in $releases) {
  foreach ($a in $r.assets) {
    $total += $a.download_count
    "{0,-12} {1,-26} {2,8}  {3}" -f $r.tag_name, $a.name, $a.download_count,
      ([datetime]$r.published_at).ToString('yyyy-MM-dd')
  }
  if (-not $r.assets) { "{0,-12} {1,-26} {2,8}  {3}" -f $r.tag_name, '(no assets attached)', 0, '' }
}
""
"total downloads: $total"
"note: counts re-downloads and bots, so treat it as an upper bound on people."

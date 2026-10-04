$ErrorActionPreference = 'Stop'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error 'GitHub CLI is required. Install it, run "gh auth login", then retry "pnpm release".'
  exit 1
}

$token = (& gh auth token 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
  Write-Error 'No GitHub CLI login was found. Run "gh auth login", then retry "pnpm release".'
  exit 1
}

$env:GH_TOKEN = $token.Trim()
& pnpm exec electron-builder --publish always
exit $LASTEXITCODE

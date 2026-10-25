param(
  [ValidateSet('run','login')]
  [string]$Mode = 'run',
  [switch]$Headless
)

$ErrorActionPreference = 'Stop'
$node = 'C:\Users\Bacassss\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$modules = 'C:\Users\Bacassss\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'

if (-not (Test-Path -LiteralPath $node)) {
  $node = (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $modules)) {
  throw 'Playwright 모듈 경로를 찾을 수 없습니다. Codex 데스크톱에서 실행해 주세요.'
}

$env:NODE_PATH = $modules
$env:ALIEXPRESS_HEADLESS = if ($Headless) { '1' } else { '0' }
& $node (Join-Path $PSScriptRoot 'aliexpress-coin.js') $Mode
exit $LASTEXITCODE

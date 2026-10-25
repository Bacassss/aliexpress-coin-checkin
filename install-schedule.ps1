param(
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
  [string]$Time = '17:00'
)

$ErrorActionPreference = 'Stop'
$taskName = 'AliExpress Coin Check-in'
$runner = Join-Path $PSScriptRoot 'run.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Mode run"
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $Time
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($dailyTrigger, $logonTrigger) -Settings $settings -Description 'AliExpress coin daily check-in at 17:00 and Windows logon' -Force | Out-Null
Write-Host "등록 완료: 매일 $Time 및 Windows 로그인 시 실행 / $taskName"

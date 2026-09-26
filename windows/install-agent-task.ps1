param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][ValidateSet("Install", "Uninstall")][string]$Mode,
  [string]$UserId,
  [string]$ElevationResultPath
)

$ErrorActionPreference = "Stop"
$taskName = "AnxOSAgent"
$legacyTaskNames = @("AnxOS Agent")
$healthDeadlineSeconds = 150
$healthRequestTimeoutSeconds = 5
$healthPollIntervalMs = 750

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-ElevationResult {
  param([int]$ExitCode)
  if (-not $ElevationResultPath) { return }
  try {
    Set-Content -LiteralPath $ElevationResultPath -Value $ExitCode -Encoding ASCII -ErrorAction Stop
  } catch {}
}

if (-not (Test-IsAdministrator)) {
  if (-not $ElevationResultPath) {
    $ElevationResultPath = Join-Path $env:TEMP ("anxos-agent-task-" + [Guid]::NewGuid().ToString("N") + ".exit")
  }
  $argumentLine = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ExecutablePath `"$ExecutablePath`" -Mode $Mode -ElevationResultPath `"$ElevationResultPath`""
  if ($UserId) { $argumentLine += " -UserId `"$UserId`"" }
  $elevated = $null
  try {
    $elevated = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -Verb RunAs -PassThru
  } catch {
    $baseError = $_.Exception.GetBaseException()
    if ($baseError -and $baseError.NativeErrorCode -eq 1223) { exit 1223 }
    exit 1
  }
  if ($null -eq $elevated) { exit 1223 }
  while ($null -ne (Get-Process -Id $elevated.Id -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 250
  }
  $childExitCode = $null
  try {
    if (Test-Path -LiteralPath $ElevationResultPath -PathType Leaf) {
      $rawResult = [string](Get-Content -LiteralPath $ElevationResultPath -Raw -ErrorAction Stop)
      $parsedResult = 0
      if ([int]::TryParse($rawResult.Trim(), [ref]$parsedResult)) { $childExitCode = $parsedResult }
    }
  } catch {}
  Remove-Item -LiteralPath $ElevationResultPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $childExitCode) {
    try {
      $reportedExitCode = $elevated.ExitCode
      if ($null -ne $reportedExitCode -and $reportedExitCode -ne 0) { $childExitCode = [int]$reportedExitCode }
    } catch {}
    if ($null -eq $childExitCode) { $childExitCode = 1 }
  }
  exit $childExitCode
}

function Stop-OwnedAgentProcess {
  param([string]$ExpectedExecutable)
  $normalizedExecutable = [IO.Path]::GetFullPath($ExpectedExecutable)
  Get-CimInstance Win32_Process -Filter "Name = 'AnxOS Control Center.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      [IO.Path]::GetFullPath($_.ExecutablePath) -eq $normalizedExecutable -and
      ($_.CommandLine -match '(?i)(?:^|\s)--agent(?:\s|$)' -or $_.CommandLine -match '(?i)local-agent-runtime.+agent[\\/]src[\\/]server\.js')
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-OwnedAgentProcess {
  param([string]$ExpectedExecutable)
  $normalizedExecutable = [IO.Path]::GetFullPath($ExpectedExecutable)
  return [bool](Get-CimInstance Win32_Process -Filter "Name = 'AnxOS Control Center.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      [IO.Path]::GetFullPath($_.ExecutablePath) -eq $normalizedExecutable -and
      $_.CommandLine -match '(?i)(?:^|\s)--agent(?:\s|$)'
    } | Select-Object -First 1)
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
$legacyTaskNames | ForEach-Object { Stop-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }
Stop-OwnedAgentProcess -ExpectedExecutable $ExecutablePath

if ($Mode -eq "Uninstall") {
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  $legacyTaskNames | ForEach-Object { Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue }
  Write-ElevationResult -ExitCode 0
  exit 0
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
  Write-ElevationResult -ExitCode 20
  exit 20
}
if ($UserId -and $UserId.StartsWith("\")) { $UserId = $UserId.TrimStart("\") }
if (-not $UserId) { $UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
$legacyTaskNames | ForEach-Object { Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue }
$workingDirectory = Split-Path -Parent $ExecutablePath
$action = New-ScheduledTaskAction -Execute $ExecutablePath -Argument "--agent" -WorkingDirectory $workingDirectory
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$healthDeadline = (Get-Date).AddSeconds($healthDeadlineSeconds)
$healthy = $false
while ((Get-Date) -lt $healthDeadline) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:47131/api/v1/health" -TimeoutSec $healthRequestTimeoutSeconds
    if ($response.StatusCode -eq 200 -and (Test-OwnedAgentProcess -ExpectedExecutable $ExecutablePath)) { $healthy = $true; break }
  } catch {}
  Start-Sleep -Milliseconds $healthPollIntervalMs
}
if (-not $healthy) {
  Write-ElevationResult -ExitCode 24
  exit 24
}
Write-ElevationResult -ExitCode 0
exit 0

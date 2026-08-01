param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][ValidateSet("Install", "Uninstall")][string]$Mode,
  [string]$UserId
)

$ErrorActionPreference = "Stop"
$taskName = "AnxOSAgent"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  $argumentLine = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ExecutablePath `"$ExecutablePath`" -Mode $Mode"
  if ($UserId) { $argumentLine += " -UserId `"$UserId`"" }
  $elevated = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -Verb RunAs -Wait -PassThru
  if ($null -eq $elevated) { exit 1223 }
  exit $elevated.ExitCode
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
Stop-OwnedAgentProcess -ExpectedExecutable $ExecutablePath

if ($Mode -eq "Uninstall") {
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  exit 0
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { exit 20 }
if ($UserId -and $UserId.StartsWith("\")) { $UserId = $UserId.TrimStart("\") }
if (-not $UserId) { $UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
$workingDirectory = Split-Path -Parent $ExecutablePath
$action = New-ScheduledTaskAction -Execute $ExecutablePath -Argument "--agent" -WorkingDirectory $workingDirectory
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$healthy = $false
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:47131/api/v1/health" -TimeoutSec 2
    if ($response.StatusCode -eq 200 -and (Test-OwnedAgentProcess -ExpectedExecutable $ExecutablePath)) { $healthy = $true; break }
  } catch {}
}
if (-not $healthy) { exit 24 }
exit 0

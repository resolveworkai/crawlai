# Authored by: Mohit Singh
<#
.SYNOPSIS
  Installs (or removes) the self-healing host-runner watchdog as a per-user Windows scheduled task.

.DESCRIPTION
  Runs scripts\host-watchdog.ps1 in YOUR logged-in session (the runners need your real, visible
  Chrome, so it cannot be a Session-0 service). No administrator rights are needed.

    Triggers : at your logon, AND every 5 minutes. The second one only matters if the watchdog
               itself has died - while it is running, "IgnoreNew" makes the repeat a no-op.
    Settings : no run-time limit, restarts itself on failure, runs on battery.

  It supersedes the old Startup-folder shortcut (business-scout-hosts.lnk), which is removed here:
  leaving both would start the runners twice at logon, and a second runner fails the first one's
  in-flight job.

  Remove it again with:  powershell -File scripts\install-host-watchdog.ps1 -Uninstall
  (Uninstalling stops the watchdog, and with it the runners it started - a running job is failed
  and can be retried.)
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'BusinessScoutHostWatchdog'
$watchdog = Join-Path $PSScriptRoot 'host-watchdog.ps1'
$legacyShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'business-scout-hosts.lnk'
$me = "$env:USERDOMAIN\$env:USERNAME"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task $TaskName."
    } else {
        Write-Host "Scheduled task $TaskName was not installed."
    }
    exit 0
}

if (-not (Test-Path $watchdog)) { throw "Cannot find $watchdog" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $watchdog) `
    -WorkingDirectory $PSScriptRoot

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $me
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $repeat) `
    -Settings $settings -Principal $principal -Force `
    -Description 'Business Scout AI: restarts the noon/Amazon.in and Property host runners if they die or hang.' | Out-Null
Write-Host "Installed scheduled task $TaskName (at logon + every 5 min, restarts on failure)."

if (Test-Path $legacyShortcut) {
    Remove-Item -Force $legacyShortcut
    Write-Host "Removed the old Startup shortcut (superseded; keeping both would start the runners twice)."
}

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started it now. Logs: backend\worker\storage\logs\host-watchdog.log"
}

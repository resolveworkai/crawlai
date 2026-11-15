# Authored by: Mohit Singh
<#
.SYNOPSIS
  Self-healing supervisor for the host runners (noon/AliExpress/Amazon.in + Property Research).

.DESCRIPTION
  The host runners are plain Windows Python processes. Nothing used to restart one that died, so a
  killed runner (or a closed window, a logoff, a crash) left jobs queued forever until a human saw
  the dashboard banner. This script is the supervisor:

    * runner process missing            -> start it (via its start-*-host.bat launcher)
    * runner alive but heartbeat stale  -> it is WEDGED: kill only its own processes, start it again
    * it keeps dying (crash loop)       -> back off instead of restarting every cycle

  Chrome is NOT supervised here: the runners already relaunch the debug Chrome themselves
  (chrome_health.ensure_chrome_running) and the launchers skip launching it when it is up.

  Safety rules, learned the hard way:
    * Runners are matched by EXACT command line (run_noon_host.py / run_property_host.py). Never a
      blanket kill of python.exe or chrome.exe.
    * A freshly started runner gets a grace period before its heartbeat is judged.
    * "Heartbeat unknown" (docker/DB unreachable) never kills anything - only a positively stale
      heartbeat does. A stale heartbeat only means "hung" because the runners heartbeat from an
      always-running task (chrome_health.heartbeat_forever), not once per cycle.
    * Starting a runner makes it fail any job it finds mid-flight (orphan recovery), so this script
      never starts a second copy of a runner that is already alive.

  Install as a logon task with scripts\install-host-watchdog.ps1. Run one pass by hand with -Once.
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 30,
    [int]$HungAfterSeconds = 300,
    [int]$StartupGraceSeconds = 120,
    [int]$CrashLoopMax = 5,
    [int]$CrashLoopWindowSeconds = 600,
    [switch]$Once,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$scriptsDir = $PSScriptRoot
$repoRoot   = (Resolve-Path (Join-Path $scriptsDir '..')).Path
$logDir     = Join-Path $repoRoot 'backend\worker\storage\logs'
$null = New-Item -ItemType Directory -Force -Path $logDir
$wdLog      = Join-Path $logDir 'host-watchdog.log'

$Runners = @(
    @{ Name = 'noon';     Script = 'run_noon_host.py';     Bat = 'start-noon-host.bat' },
    @{ Name = 'property'; Script = 'run_property_host.py'; Bat = 'start-property-host.bat' }
)

function Write-Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
    try {
        if ((Test-Path $wdLog) -and ((Get-Item $wdLog).Length -gt 5MB)) { Move-Item -Force $wdLog "$wdLog.1" }
        Add-Content -Path $wdLog -Value $line -Encoding ASCII
    } catch { }
    Write-Host $line
}

function Get-RunnerProcesses([string]$Script) {
    # Both the venv launcher and the real interpreter carry the script name; either counts as alive.
    $pattern = [regex]::Escape($Script)
    @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match $pattern })
}

# Seconds since the runner last heartbeat, or $null when it cannot be determined (docker down, no
# row yet). $null means "do not judge" - never "hung".
function Get-HeartbeatAgeSeconds([string]$Name) {
    try {
        $sql = "SELECT round(extract(epoch FROM now()-last_heartbeat_at)) FROM host_runner_status WHERE runner_name='$Name';"
        $out = & docker exec business-scout-postgres psql -U postgres -d master_db_crawler -t -A -c $sql 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $text = ($out | Out-String).Trim()
        if ($text -match '^\d+(\.\d+)?$') { return [double]$text }
    } catch { }
    return $null
}

function Test-CrashLoop([string]$Name) {
    $cutoff = (Get-Date).AddSeconds(-$CrashLoopWindowSeconds)
    $script:RestartTimes[$Name] = @($script:RestartTimes[$Name] | Where-Object { $_ -gt $cutoff })
    return ($script:RestartTimes[$Name].Count -ge $CrashLoopMax)
}

function Start-Runner($Runner) {
    $bat = Join-Path $scriptsDir $Runner.Bat
    # A NEW log file per launch, never a fixed name: the debug Chrome inherits the launcher's
    # redirected output handle and keeps that file open for its whole life, so reusing one path
    # made every relaunch fail on the redirect (file in use) before the launcher even ran.
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $log = Join-Path $logDir ('{0}-host-{1}.log' -f $Runner.Name, $stamp)
    if ($DryRun) { Write-Log "[dry-run] would start $($Runner.Name) via $($Runner.Bat)"; return }
    Add-Content -Path $log -Value ("=== {0} watchdog starting {1} ===" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Runner.Name) -Encoding ASCII
    # Keep the newest few; ones still held open by a live Chrome simply fail to delete - ignored.
    Get-ChildItem -Path $logDir -Filter ('{0}-host-*.log' -f $Runner.Name) -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip 8 |
        ForEach-Object { Remove-Item -Force -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
    # /s makes cmd strip exactly the outer quotes, so the inner quoted paths survive.
    $arguments = '/s /c ""' + $bat + '" >> "' + $log + '" 2>&1"'
    Start-Process -FilePath 'cmd.exe' -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    $script:RestartTimes[$Runner.Name] += (Get-Date)
    # Wait for the python process to actually appear so a concurrent pass does not start a second
    # copy (a second runner would fail the first one's in-flight job via orphan recovery).
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if ((Get-RunnerProcesses $Runner.Script).Count -gt 0) { Write-Log "$($Runner.Name): started"; return }
    }
    Write-Log "$($Runner.Name): launched but no process appeared within 20s - see $log"
}

function Invoke-Pass {
    foreach ($runner in $Runners) {
        $name  = $runner.Name
        $procs = Get-RunnerProcesses $runner.Script

        if ($procs.Count -eq 0) {
            if (Test-CrashLoop $name) {
                Write-Log "${name}: DOWN but restarted $CrashLoopMax times in the last $CrashLoopWindowSeconds s - backing off (see backend\worker\storage\logs\$name-host-*.log)"
                continue
            }
            Write-Log "${name}: not running - restarting"
            Start-Runner $runner
            continue
        }

        $newest   = ($procs | Measure-Object -Property CreationDate -Maximum).Maximum
        $ageOfRun = ((Get-Date) - $newest).TotalSeconds
        if ($ageOfRun -lt $StartupGraceSeconds) { continue }

        $hb = Get-HeartbeatAgeSeconds $runner.Name
        if ($null -eq $hb) { continue }
        if ($hb -gt $HungAfterSeconds) {
            Write-Log ("${name}: heartbeat is {0}s old (limit {1}s) while the process is alive - WEDGED, restarting" -f $hb, $HungAfterSeconds)
            if (-not $DryRun) {
                foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
                Start-Sleep -Seconds 2
            }
            Start-Runner $runner
        }
    }
}

$script:RestartTimes = @{}
foreach ($r in $Runners) { $script:RestartTimes[$r.Name] = @() }

# Only one long-running watchdog at a time (a second would just race the first).
$singleton = $null
if (-not $Once) {
    $created = $false
    $singleton = New-Object System.Threading.Mutex($true, 'Local\business-scout-host-watchdog', [ref]$created)
    if (-not $created) { Write-Host 'Another host watchdog is already running - exiting.'; exit 0 }
}

# Any two passes (the loop, or a manual -Once) serialise here, so check-then-start is never raced.
$passMutex = New-Object System.Threading.Mutex($false, 'Local\business-scout-host-pass')
try {
    Write-Log ("watchdog up (interval {0}s, hung-after {1}s, grace {2}s{3})" -f $IntervalSeconds, $HungAfterSeconds, $StartupGraceSeconds, $(if ($DryRun) { ', DRY RUN' } else { '' }))
    do {
        if ($passMutex.WaitOne(60000)) {
            try { Invoke-Pass } catch { Write-Log "pass failed: $($_.Exception.Message)" } finally { $passMutex.ReleaseMutex() }
        }
        if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
    } while (-not $Once)
}
finally {
    if ($singleton) { try { $singleton.ReleaseMutex() } catch { } }
}

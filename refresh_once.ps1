# One-shot UF roster refresh. Never makes sheets public. Never embeds an API key.
# Unattended access to Adam's private Sheets requires secrets/token.json or
# secrets/service-account.json. Those files are not present, so 1am cannot
# re-download a private sheet by itself. This script:
#   1) Tries the Sheets API if credentials exist
#   2) Else rebuilds from CSVs already in Downloads (signed-in File → Download)
#   3) Else opens the sheet + a reminder (Adam must export while signed in)
#
# Do not steal browser cookies. Do not commit CSVs or secrets.

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Repo

$Python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
if (-not (Test-Path $Python)) {
    $Python = (Get-Command python -ErrorAction SilentlyContinue).Source
}
if (-not $Python -or -not (Test-Path $Python)) {
    throw 'Python not found. Install Python 3.12 and re-run.'
}

$Downloads = Join-Path $env:USERPROFILE 'Downloads'
$AppsNeedle = 'FL2026 Rem on Campus Application (Responses)*Form Responses 1.csv'
$CoffeeNeedle = 'Rem Fall 2026 Coffee Chats Sign-In (Responses)*Form Responses 1.csv'
$InfoNeedle = '*Info Session Attendances.csv'
$SheetUrl = 'https://docs.google.com/spreadsheets/d/1gu164myetDxGxQzZwlecYdauuEHiPpOekfOlYCUiPyQ/edit?gid=1963958788#gid=1963958788'

function Newest-Match([string]$pattern) {
    Get-ChildItem -Path $Downloads -Filter $pattern -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function Show-Reminder([string]$message) {
    Start-Process $SheetUrl
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $message,
        'REM UF roster refresh',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
}

$log = Join-Path $Repo 'refresh_once.log'
function Log([string]$m) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path $log -Value $line
    Write-Output $line
}

Log 'refresh_once starting'

$usedApi = $false
$apiOk = $false
if ((Test-Path (Join-Path $Repo 'secrets\token.json')) -or
    (Test-Path (Join-Path $Repo 'secrets\service-account.json')) -or
    $env:GOOGLE_APPLICATION_CREDENTIALS) {
    Log 'trying Sheets API via refresh.py'
    try {
        & $Python (Join-Path $Repo 'refresh.py') --commit --push
        if ($LASTEXITCODE -eq 0) { $apiOk = $true; $usedApi = $true }
    } catch {
        Log 'Sheets API refresh failed (credentials missing or unauthorized)'
    }
} else {
    Log 'no secrets/token.json or service-account.json — cannot read a private sheet unattended'
}

if ($apiOk) {
    Log 'API refresh committed and pushed'
    exit 0
}

$apps = Newest-Match $AppsNeedle
$coffee = Newest-Match $CoffeeNeedle
$info = Newest-Match $InfoNeedle

if (-not $apps) {
    Log 'no applications CSV in Downloads — opening reminder'
    Show-Reminder @"
1:00 AM reminder: this machine cannot read the private national applications sheet without you.

Stay signed in as adam.kamenetsky24@gmail.com, then:
1. File → Download → Comma Separated Values (.csv) on tab Form Responses 1
2. Same for Coffee Chats (Form Responses 1) and mastersheet tab Info Session Attendances
3. Re-run refresh_once.ps1 (or leave those CSVs in Downloads and run this task again)

Do not make the sheet public. Do not add a Google API key to the dashboard.
"@
    exit 2
}

Log ("rebuilding from CSV: {0}" -f $apps.Name)
$pyArgs = @(
    (Join-Path $Repo 'refresh.py'),
    '--apps-csv', $apps.FullName
)
if ($coffee) { $pyArgs += @('--coffee-csv', $coffee.FullName) }
if ($info) { $pyArgs += @('--info-csv', $info.FullName) }
$pyArgs += @('--commit', '--push')

& $Python @pyArgs
if ($LASTEXITCODE -ne 0) {
    Log 'CSV rebuild failed'
    exit $LASTEXITCODE
}
Log 'CSV rebuild committed and pushed'
exit 0

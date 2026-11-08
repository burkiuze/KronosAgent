# Kronos kurulum betigi - Kronos-Kurulum.exe tarafindan calistirilir.
# Gereken bilesenleri (Node.js, Git) kontrol eder, yoksa kurar; KronosAgent'i indirir,
# bagimliliklarini yukler, derler ve masaustu / Baslat menusu kisayolu olusturur.
# (Gunluk ciktisi bilincli olarak ASCII: kurulum penceresinde dogru gorunsun diye.)
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$Branch = 'ccr-0324e4d1-tlvrwx',
  [string]$Repo = 'https://github.com/burkiuze/KronosAgent'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$env:npm_config_update_notifier = 'false'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'

function Step([string]$m) { Write-Output ''; Write-Output "==> $m" }
function Info([string]$m) { Write-Output "    $m" }
function Has([string]$c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Add-PathIfExists([string]$dir) {
  if ((Test-Path $dir) -and -not (($env:Path -split ';') -contains $dir)) { $env:Path = "$dir;$env:Path" }
}
function Run([string]$exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "'$exe $($argv -join ' ')' basarisiz oldu (kod $LASTEXITCODE)" }
}
function Download([string]$url, [string]$out) {
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -Headers @{ 'User-Agent' = 'Kronos-Kurulum' }; return }
    catch { if ($i -eq 3) { throw "Indirilemedi: $url ($($_.Exception.Message))" }; Info "Tekrar deneniyor ($i)..."; Start-Sleep -Seconds (2 * $i) }
  }
}

$isArm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'
$tmp = Join-Path $env:TEMP 'kronos-kurulum'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

try {
  # ------------------------------------------------------------------ 1. Node.js (>= 20.19)
  Step '1/5  Node.js kontrol ediliyor'
  Add-PathIfExists "$env:ProgramW6432\nodejs"
  Add-PathIfExists "$env:ProgramFiles\nodejs"
  $needNode = $true
  if (Has node) {
    $v = ((& node -v) -replace '^v', '').Trim()
    if ([version]$v -ge [version]'20.19.0') { $needNode = $false; Info "Node.js $v bulundu, kurulum gerekmiyor." }
    else { Info "Node.js $v eski; guncel LTS surumu kurulacak." }
  } else { Info 'Node.js bulunamadi; kurulacak.' }

  if ($needNode) {
    Info 'Guncel Node.js LTS surumu bulunuyor...'
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $rel = $index | Where-Object { $_.lts -and $_.version -like 'v22.*' } | Select-Object -First 1
    if (-not $rel) { $rel = $index | Where-Object { $_.lts } | Select-Object -First 1 }
    $arch = if ($isArm) { 'arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
    $msi = Join-Path $tmp 'node.msi'
    Info "Node.js $($rel.version) ($arch) indiriliyor..."
    Download "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-$arch.msi" $msi
    Info 'Node.js kuruluyor...'
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Node.js kurulumu basarisiz (kod $($p.ExitCode))" }
    Refresh-Path
    Add-PathIfExists "$env:ProgramW6432\nodejs"
    Add-PathIfExists "$env:ProgramFiles\nodejs"
    if (-not (Has node)) { throw 'Node.js kuruldu ama bulunamadi. Bilgisayari yeniden baslatip kurulumu tekrar calistir.' }
    Info "Node.js $((& node -v).Trim()) kuruldu."
  }

  # ------------------------------------------------------------------ 2. Git
  Step '2/5  Git kontrol ediliyor'
  Add-PathIfExists "$env:ProgramW6432\Git\cmd"
  Add-PathIfExists "$env:ProgramFiles\Git\cmd"
  if (Has git) {
    Info "$((& git --version).Trim()) bulundu, kurulum gerekmiyor."
  } else {
    Info 'Git bulunamadi; kurulacak. Guncel surum bulunuyor...'
    $r = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing -Headers @{ 'User-Agent' = 'Kronos-Kurulum' }
    $pattern = if ($isArm) { '^Git-.*-arm64\.exe$' } else { '^Git-.*-64-bit\.exe$' }
    $asset = $r.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if (-not $asset) { throw 'Git kurulum dosyasi bulunamadi.' }
    $exe = Join-Path $tmp 'git-setup.exe'
    Info "$($asset.name) indiriliyor..."
    Download $asset.browser_download_url $exe
    Info 'Git kuruluyor...'
    $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Git kurulumu basarisiz (kod $($p.ExitCode))" }
    Refresh-Path
    Add-PathIfExists "$env:ProgramW6432\Git\cmd"
    Add-PathIfExists "$env:ProgramFiles\Git\cmd"
    if (-not (Has git)) { throw 'Git kuruldu ama bulunamadi. Bilgisayari yeniden baslatip kurulumu tekrar calistir.' }
    Info "$((& git --version).Trim()) kuruldu."
  }

  # ------------------------------------------------------------------ 3. KronosAgent
  Step '3/5  KronosAgent indiriliyor'
  $app = Join-Path $InstallDir 'app'
  if (Test-Path (Join-Path $app '.git')) {
    Info 'Mevcut kurulum bulundu; en yeni surume guncelleniyor...'
    Run 'git' @('-C', $app, 'fetch', '--depth', '1', '--quiet', 'origin', $Branch)
    Run 'git' @('-C', $app, 'reset', '--hard', '--quiet', 'FETCH_HEAD')
  } else {
    if (Test-Path $app) { Remove-Item -Recurse -Force $app }
    Run 'git' @('clone', '--depth', '1', '--quiet', '--branch', $Branch, $Repo, $app)
  }
  Info 'Kaynak kod hazir.'

  # ------------------------------------------------------------------ 4. Bilesenler + derleme
  Push-Location $app
  try {
    Step '4/5  Bilesenler yukleniyor (npm install) - birkac dakika surebilir'
    Run 'npm' @('install', '--no-audit', '--no-fund', '--loglevel=error')
    Step '      Kronos derleniyor'
    Run 'npm' @('run', 'build')
    Run 'npm' @('run', 'build', '-w', '@kronos/desktop')
  } finally { Pop-Location }

  # ------------------------------------------------------------------ 5. Kisayollar
  Step '5/5  Kisayollar olusturuluyor'
  $electron = @(
    (Join-Path $app 'node_modules\electron\dist\electron.exe'),
    (Join-Path $app 'apps\desktop\node_modules\electron\dist\electron.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $electron) { throw 'Uygulama calistiricisi bulunamadi (bilesen yuklemesi eksik kalmis olabilir).' }

  $desktopApp = Join-Path $app 'apps\desktop'
  $icon = Join-Path $InstallDir 'kronos.ico'
  $shell = New-Object -ComObject WScript.Shell
  $links = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kronos.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Kronos.lnk')
  )
  foreach ($lnk in $links) {
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = $electron
    $s.Arguments = "`"$desktopApp`""
    $s.WorkingDirectory = $desktopApp
    if (Test-Path $icon) { $s.IconLocation = $icon }
    $s.Description = 'Kronos'
    $s.Save()
  }
  Info 'Masaustu ve Baslat menusu kisayollari eklendi.'

  Step 'Kurulum tamamlandi.'
  Info 'Ilk acilista ucretsiz modeller arka planda hazirlanir; API anahtari gerekmez.'
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  exit 0
}
catch {
  Write-Output ''
  Write-Output "HATA: $($_.Exception.Message)"
  exit 1
}

; Kronos kurulum sihirbazi (NSIS). Derleme: makensis kronos-kurulum.nsi
Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

!define APPNAME "Kronos"
!define APPVER "1.0.2"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kronos"

Name "${APPNAME}"
Caption "${APPNAME} Kurulumu"
OutFile "Kronos-Kurulum.exe"
InstallDir "$LOCALAPPDATA\Programs\KronosAgent"
InstallDirRegKey HKCU "${UNKEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
BrandingText "Kronos"

VIProductVersion "${APPVER}.0"
VIAddVersionKey /LANG=1055 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1055 "FileDescription" "${APPNAME} Kurulumu"
VIAddVersionKey /LANG=1055 "FileVersion" "${APPVER}"
VIAddVersionKey /LANG=1055 "ProductVersion" "${APPVER}"
VIAddVersionKey /LANG=1055 "LegalCopyright" "Apache-2.0"

!define MUI_ICON "kronos.ico"
!define MUI_UNICON "kronos.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Kronos Kurulumuna Hoş Geldin"
!define MUI_WELCOMEPAGE_TEXT "Bu sihirbaz Kronos'u ve ihtiyaç duyduğu her şeyi kuracak:$\r$\n$\r$\n   •  Node.js  (bilgisayarında yoksa)$\r$\n   •  Git  (bilgisayarında yoksa)$\r$\n   •  KronosAgent uygulaması ve bileşenleri$\r$\n   •  Kronos motoru$\r$\n$\r$\nKurulum internetten indirme yapar ve bağlantına göre birkaç dakika sürebilir.$\r$\n$\r$\nKronos ücretsiz modellerle hazır gelir; hesap veya API anahtarı gerekmez.$\r$\n$\r$\nDevam etmek için İleri'ye tıkla."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Kronos hazır"
!define MUI_FINISHPAGE_TEXT "Kronos kuruldu. Masaüstündeki ve Başlat menüsündeki Kronos kısayoluyla açabilirsin.$\r$\n$\r$\nİpucu: Ctrl + Shift + K ile Kronos'u her yerden aç/gizle."
!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_TEXT "Kronos'u şimdi başlat"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchKronos
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Turkish"

Section "Kronos" SecMain
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "kurulum.ps1"
  File "kronos.ico"

  DetailPrint "Kurulum başlıyor. Bu pencereyi kapatma..."
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::ExecToLog '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\kurulum.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}

  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "Kurulum tamamlanamadı (kod: $0).$\r$\n$\r$\nAyrıntılar kurulum günlüğünde. İnternet bağlantını kontrol edip kurulumu tekrar çalıştır."
    Abort "Kurulum tamamlanamadı."
  ${EndIf}

  WriteUninstaller "$INSTDIR\Kaldir.exe"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${APPVER}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "Kronos"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\kronos.ico"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Kaldir.exe"'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
SectionEnd

; launched through Explorer so the app runs as the normal user, not elevated like the installer
Function LaunchKronos
  SetShellVarContext current
  Exec '"$WINDIR\explorer.exe" "$DESKTOP\Kronos.lnk"'
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Kronos.lnk"
  Delete "$SMPROGRAMS\Kronos.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNKEY}"
SectionEnd

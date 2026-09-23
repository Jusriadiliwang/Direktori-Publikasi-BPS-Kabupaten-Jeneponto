@echo off
:: Script untuk membuat shortcut di Desktop
setlocal

set "TARGET=%~dp0START SERVER.bat"
set "SHORTCUT=%USERPROFILE%\Desktop\BPS Jeneponto.lnk"
set "ICON=%~dp0public\assets\logo-bps.png"

:: Buat shortcut menggunakan PowerShell
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $sc = $ws.CreateShortcut('%SHORTCUT%'); ^
   $sc.TargetPath = 'cmd.exe'; ^
   $sc.Arguments = '/c \""%TARGET%\"\"'; ^
   $sc.WorkingDirectory = '%~dp0'; ^
   $sc.Description = 'BPS Jeneponto - Direktori Publikasi'; ^
   $sc.WindowStyle = 1; ^
   $sc.Save()"

if exist "%SHORTCUT%" (
    echo.
    echo  [OK] Shortcut berhasil dibuat di Desktop!
    echo       File: BPS Jeneponto.lnk
    echo.
    echo  Klik dua kali shortcut tersebut untuk membuka aplikasi.
) else (
    echo  [GAGAL] Tidak bisa membuat shortcut.
)
pause

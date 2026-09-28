@echo off
setlocal
title BPS Jeneponto - Server Publikasi
color 1F
cd /d "%~dp0"

echo.
echo  =====================================================
echo   BADAN PUSAT STATISTIK KABUPATEN JENEPONTO
echo   Sistem Direktori Publikasi dan Indikator Makro
echo  =====================================================
echo.

:: Cek Node.js
where node >nul 2>&1
if errorlevel 1 (
    color 4F
    echo  [ERROR] Node.js tidak ditemukan!
    echo  Install dari https://nodejs.org
    pause & exit /b 1
)

:: Matikan proses lama di port 3000 (jika ada)
echo  Memeriksa port 3000...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    echo  Mematikan proses lama (PID: %%a)...
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: API key BPS WebAPI (gratis: https://webapi.bps.go.id) agar kutipan di Chat
:: langsung membuka file PDF. Simpan di file .env (baris: BPS_API_KEY=...) atau
:: set sebagai variabel lingkungan Windows bernama BPS_API_KEY. Jangan tulis
:: key langsung di file ini karena file ini ikut ke repositori.
if "%BPS_API_KEY%"=="" if exist .env for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="BPS_API_KEY" set "BPS_API_KEY=%%b"

:: Start server
echo  Memulai server...
echo.
start "" /min cmd /c "node server.js"

:: Tunggu server siap
set /a coba=0
:cek
timeout /t 1 /nobreak >nul
curl -s http://localhost:3000/api/stats >nul 2>&1
if not errorlevel 1 goto ok
set /a coba+=1
if %coba% geq 15 goto gagal
goto cek

:ok
echo  =====================================================
echo   Server berhasil berjalan!
echo.
echo   Halaman Utama  : http://localhost:3000
echo   Chat BPS       : http://localhost:3000/chat.html
echo   Indikator Makro: http://localhost:3000/indikator.html
echo   Tabel Dinamis  : http://localhost:3000/tabel.html
echo   Panel Admin    : http://localhost:3000/admin/
echo  =====================================================
echo.
echo   Login Admin: admin / admin123
echo.
start "" "http://localhost:3000"
timeout /t 2 /nobreak >nul
echo  Browser sudah dibuka.
echo  Tutup jendela CMD yang kecil untuk MATIKAN server.
echo  Tekan tombol apapun untuk tutup jendela ini...
pause >nul
exit /b 0

:gagal
color 4F
echo  [ERROR] Server gagal dimulai.
echo  Coba jalankan: node server.js
pause
exit /b 1

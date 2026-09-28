@echo off
setlocal
title BPS Jeneponto - Ambil Link PDF Publikasi
color 1F
cd /d "%~dp0"

echo.
echo  =====================================================
echo   AMBIL LINK PDF PUBLIKASI BPS JENEPONTO
echo   Melengkapi tautan file PDF (url_pdf) tiap publikasi
echo   agar kutipan di fitur Chat langsung membuka PDF.
echo  =====================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    color 4F
    echo  [ERROR] Node.js tidak ditemukan!
    echo  Install dari https://nodejs.org
    pause & exit /b 1
)

echo  Mode: HEADED (jendela Chrome akan terbuka)
echo  Jika muncul verifikasi Cloudflare, selesaikan manual -
echo  skrip akan lanjut otomatis. Aman dijalankan ulang;
echo  publikasi yang sudah punya link akan dilewati.
echo.
echo  Tekan tombol apapun untuk mulai...
pause >nul

echo.
echo  [1] Publikasi Jeneponto...
node scrape-pdf-links.js

echo.
echo  [2] Publikasi Sulawesi Selatan...
node scrape-pdf-links.js --wilayah sulsel

echo.
echo  =====================================================
echo   Selesai! Jalankan ulang START SERVER.bat
echo  =====================================================
echo.
pause

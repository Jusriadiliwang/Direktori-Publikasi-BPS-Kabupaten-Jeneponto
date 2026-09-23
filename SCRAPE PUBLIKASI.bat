@echo off
setlocal
title BPS Jeneponto - Scraper Publikasi
color 1F
cd /d "%~dp0"

echo.
echo  =====================================================
echo   SCRAPER PUBLIKASI BPS JENEPONTO
echo   Mengambil semua publikasi dari BPS online
echo  =====================================================
echo.

:: Cek Python
where python >nul 2>&1
if errorlevel 1 (
    color 4F
    echo  [ERROR] Python tidak ditemukan!
    echo  Install dari https://python.org
    pause & exit /b 1
)

echo  Mode: HEADED (jendela browser Chrome akan terbuka)
echo  Jika muncul CAPTCHA atau halaman Cloudflare,
echo  selesaikan manual - scraper akan lanjut otomatis.
echo.
echo  Menekan tombol apapun untuk mulai...
pause >nul

echo.
echo  [1] Mulai scraping semua publikasi...
echo.
python -u restore_dan_download.py --hanya-scrape

echo.
echo  =====================================================
echo   Scraping selesai!
echo  =====================================================
echo.
echo  Data tersimpan di: db\publikasi.json
echo.
pause

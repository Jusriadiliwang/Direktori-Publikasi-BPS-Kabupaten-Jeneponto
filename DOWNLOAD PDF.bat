@echo off
setlocal
title BPS Jeneponto - Download PDF
color 1F
cd /d "%~dp0"

echo.
echo  =====================================================
echo   DOWNLOAD PDF PUBLIKASI BPS JENEPONTO
echo   Mendownload semua PDF ke penyimpanan lokal
echo  =====================================================
echo.

:: Cek data
python -c "import json; d=json.load(open('db/publikasi.json')); print(f'Data: {len(d)} publikasi')" 2>nul
if errorlevel 1 (
    echo  [ERROR] db\publikasi.json tidak ditemukan atau rusak.
    echo  Jalankan dulu: SCRAPE PUBLIKASI.bat
    pause & exit /b 1
)

echo.
echo  Jendela browser Chrome akan terbuka untuk mengambil
echo  link download tiap PDF, lalu download otomatis.
echo.
echo  Tekan tombol apapun untuk mulai...
pause >nul

echo.
python -u restore_dan_download.py --hanya-download

echo.
echo  =====================================================
echo   Download selesai! PDF tersimpan di: uploads\files\
echo  =====================================================
echo.
pause

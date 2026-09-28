# Direktori Publikasi BPS Kabupaten Jeneponto

Portal publikasi + indikator statistik BPS Jeneponto (dan Prov. Sulawesi Selatan) dengan chatbot berbasis pencarian teks PDF. Tidak ada database: semua data adalah file JSON di `db/`.

## Bahasa & gaya

- Seluruh kode, komentar, nama variabel/fungsi, pesan error, dan teks UI memakai **Bahasa Indonesia** (`baca`, `tulis`, `pesan`, `cariPub`, `'Login diperlukan'`). Pertahankan ini.
- Nama file: kebab-case untuk JS (`scrape-all.js`), snake_case untuk Python (`build_pdf_index.py`). Kunci JSON: snake_case/camelCase campuran sesuai file yang ada — ikuti kunci yang sudah dipakai di file tersebut, jangan mengganti nama kunci.
- Header seksi di `server.js` memakai komentar `// ── Judul ────`. Ikuti pola ini saat menambah blok baru.
- Frontend adalah **vanilla JS + CSS embedded** dalam satu file HTML per halaman, tanpa framework/CDN. Warna memakai CSS custom properties (`--navy`, `--blue`, `--accent`). Jangan tambahkan bundler, React, Tailwind, dsb.
- Simpan file selalu sebagai UTF-8 (pernah ada korupsi encoding pada karakter `─`/`•`; lihat `_fix-encoding.js`).

## Arsitektur

```
public/*.html  ──fetch('/api/…')──▶  server.js (Express, 1 file, ±1750 baris)
                                        │  baca()/tulis() sinkron
                                        ▼
                                     db/*.json  ◀── skrip scraper/builder (node & python)
```

- [server.js](server.js): satu file berisi 35 route. Semua I/O JSON sinkron via helper `baca(f)` / `tulis(f, d)`; tidak ada locking — jangan ubah ke DB atau async tanpa diminta.
- Lokasi data: `DATA_DIR` (env, default = root proyek) → `DB_DIR = DATA_DIR/db`, `UPLOAD_DIR = DATA_DIR/uploads`. Di Render `DATA_DIR=/data` (persistent disk) dan folder `db/`+`uploads/` repo di-*seed* ke sana saat pertama jalan. **Selalu pakai konstanta `*_FILE`/`*_DIR` yang ada, jangan hardcode path `db/`.** Pengecualian: `downloads/sulsel/` selalu relatif `__dirname`.
- Mode wilayah: halaman yang sama melayani `/` (Jeneponto) dan `/sulsel` (Sulsel). `public/index.html` menentukan `REGION` dari `location.pathname`; server memisahkan file data `*-sulsel.json` dan endpoint `*-sulsel`.
- Chatbot (`POST /api/chat`, [server.js#L335](server.js#L335)–±1000): deteksi intent berbasis kata kunci/regex + `SUMBER_MAP` untuk memetakan indikator → publikasi sumber, lalu mencari di `indikator.json`, `kecamatan.json`, dan chunk teks PDF (`pdf-index*.json`). Tidak ada LLM. Menambah jenis pertanyaan = menambah cabang deteksi di handler ini.
- Auth: JWT (`Authorization: Bearer`) + bcryptjs. `requireAuth` untuk user, `requireAdmin` untuk admin. Admin default `admin/admin123` dibuat otomatis jika `db/admin.json` belum ada (file ini di-gitignore).
- Upload: multer 50 MB → `uploads/covers` (field `cover`) atau `uploads/files`; PDF hasil upload otomatis diindeks oleh [pdf-indexer.js](pdf-indexer.js) ke `db/pdf-index-upload.json`.

## File data (`db/`) dan penghasilnya

| File | Penghasil | Catatan |
|---|---|---|
| `publikasi.json` | `scrape-all.js` / `restore_dan_download.py` / `/api/admin/import` | Publikasi Jeneponto |
| `publikasi-sulsel.json` | `scrape-all-sulsel.js` | ~770 entri |
| `indikator.json` (±3 MB) | `refresh-indikator.js` (Google Sheets `s.bps.go.id/7304_indikatormakro`) | Array-of-arrays per sheet; **jangan edit manual / jangan baca utuh ke konteks** |
| `tabel-makro.json`, `kecamatan.json` | `refresh-indikator.js` / `build_tabel_makro.py` | Turunan dari `indikator.json` |
| `tabel-dinamis.json` | `scrape-tabel-dinamis.js` (query-builder BPS, intercept RSC) | Metadata var_id |
| `pdf-index.json`, `pdf-index-sulsel.json` (4 MB) | `build_pdf_index.py`, `_sulsel_build_index.py` (pdfplumber) | Chunk teks PDF; **jangan baca utuh** |
| `kabupaten-sulsel.json`, `indikator-sulsel.json` | `build_sulsel_data.py` | Diekstrak dari PDF "Sulsel Dalam Angka" |
| `sumber.json` | manual | Registri sumber data yang ditampilkan di UI |

File berawalan `_` di root (`_dl_*.js`, `_sulsel_debug.js`, `_test_sulsel.js`, `_fix-encoding.js`) adalah skrip sekali-pakai/debug — jangan dijadikan acuan pola dan jangan di-refactor. `check-pub.js`, `cek-index.js`, `analisis-qb.js`, `parse-excel.js` juga diagnostik.

## Menjalankan & menguji

- `npm install` lalu `npm start` (= `node server.js`, port `PORT` atau 3000). Playwright diperlukan oleh `server.js` (import di atas) — jika chromium belum ada: `npx playwright install chromium`.
- Tidak ada test suite maupun linter. Verifikasi perubahan API dengan `curl` ke `http://127.0.0.1:3000/api/...` (contoh chatbot: `curl -X POST -H 'Content-Type: application/json' -d '{"pesan":"jumlah penduduk 2024"}' http://127.0.0.1:3000/api/chat`). `_test_sulsel.js` adalah contoh pengujian manual chatbot.
- Python: tidak ada `requirements.txt`; skrip memakai `pdfplumber`, `playwright` (sync API), dan stdlib. Jalankan dengan `python -u nama_skrip.py`.
- Scraper ke `*.bps.go.id` sering terkena Cloudflare/CAPTCHA; skrip dirancang berjalan **headed** di Windows (lihat `*.bat`). Jangan menjalankan scraper otomatis di lingkungan headless kecuali diminta.
- `downloads/` (±460 MB PDF) tidak di-gitignore tetapi jangan pernah dimuat/dicari isinya secara massal; `uploads/` di-gitignore.
- Deploy: Render via [render.yaml](render.yaml) (Node 20, disk `/data`) atau [Procfile](Procfile). Pengguna akhir di Windows memakai file `*.bat` di root.

## Hal yang perlu diwaspadai

- `JWT_SECRET` masih hardcoded di `server.js`; jika diubah ke env var, sediakan fallback agar lokal tetap jalan.
- Route `/api/admin/import` dan `/api/admin/refresh/indikator` berjalan lama (Playwright / unduh XLSX) di proses yang sama dengan server.
- Angka dari sheet berformat Indonesia (`1.234,56`) — gunakan helper `fmt()` di `/api/chat` atau parsing serupa, jangan `parseFloat` langsung.
- Saat menambah publikasi/kategori baru untuk chatbot, perbarui juga `SUMBER_MAP` di `server.js` agar jawaban menyertakan publikasi sumber.

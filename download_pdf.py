"""
download_pdf.py – Download semua PDF publikasi BPS Jeneponto ke lokal
Jalankan: python -u download_pdf.py
         python -u download_pdf.py --mulai 0 --selesai 50
         python -u download_pdf.py --lewati   (lewati yg sudah ada)
"""

import json, os, sys, time, re, argparse, urllib.request
from pathlib import Path

# ── Konfigurasi ─────────────────────────────────────────────────
BASE_DIR  = Path(__file__).parent
DATA_FILE = BASE_DIR / 'db' / 'publikasi.json'
SAVE_DIR  = BASE_DIR / 'uploads' / 'files'
SAVE_DIR.mkdir(parents=True, exist_ok=True)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[ERROR] Jalankan: pip install playwright"); sys.exit(1)


def slug(judul: str, ext='.pdf') -> str:
    s = re.sub(r'[\\/:*?"<>|]', ' ', judul)
    s = re.sub(r'\s+', '_', s.strip())[:80]
    return s + ext


def dl_url_to_file(url: str, path: Path) -> tuple[bool, int]:
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/124.0.0',
            'Referer'   : 'https://jenepontokab.bps.go.id/',
        })
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        if len(data) < 500:
            return False, 0
        path.write_bytes(data)
        return True, len(data)
    except Exception:
        return False, 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mulai',   type=int, default=0)
    parser.add_argument('--selesai', type=int, default=None)
    parser.add_argument('--lewati',  action='store_true', help='Lewati yg sudah ada')
    args = parser.parse_args()

    data      = json.loads(DATA_FILE.read_text('utf-8'))
    batas     = args.selesai or len(data)
    target    = data[args.mulai:batas]
    ok=0; fail=0; skip=0; total_kb=0

    print(f'\n{"="*62}')
    print(f'  DOWNLOAD PDF PUBLIKASI BPS JENEPONTO')
    print(f'  Target  : {len(target)} publikasi (#{args.mulai+1}–#{batas})')
    print(f'  Simpan  : {SAVE_DIR}')
    print(f'  Tekan Ctrl+C untuk hentikan kapan saja')
    print(f'{"="*62}\n', flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx     = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            locale='id-ID',
        )
        page = ctx.new_page()

        for i, pub in enumerate(target):
            n       = args.mulai + i + 1
            judul   = pub.get('judul', f'pub_{n}')
            pub_url = pub.get('url', '')
            fname   = slug(judul)
            fpath   = SAVE_DIR / fname
            prefix  = f'[{n:3}/{batas}]'

            print(f'{prefix} {judul[:52]}...', flush=True)

            # Lewati jika sudah ada
            if args.lewati and fpath.exists() and fpath.stat().st_size > 10000:
                print(f'         ⏭  Sudah ada ({fpath.stat().st_size//1024} KB)', flush=True)
                pub['fileLokal'] = f'/uploads/files/{fname}'
                skip += 1; continue

            if not pub_url:
                print(f'         ❌ Tidak ada URL', flush=True)
                fail += 1; continue

            # Buka halaman BPS
            try:
                page.goto(pub_url, wait_until='domcontentloaded', timeout=20000)
                time.sleep(1.5)
            except Exception:
                print(f'         ❌ Gagal buka halaman', flush=True)
                fail += 1; continue

            # Cari link download
            dl = page.evaluate('''() => {
                for (const a of document.querySelectorAll("a")) {
                    if (a.href && a.href.includes("download")) return a.href;
                }
                return null;
            }''')

            if not dl:
                print(f'         ❌ Link download tidak ditemukan', flush=True)
                fail += 1; time.sleep(0.5); continue

            # Download file
            success, size = dl_url_to_file(dl, fpath)
            if success:
                kb = size // 1024
                total_kb += kb
                print(f'         ✅ {fname[:45]} ({kb} KB)', flush=True)
                pub['fileLokal'] = f'/uploads/files/{fname}'
                ok += 1
            else:
                print(f'         ❌ Gagal download', flush=True)
                fail += 1

            time.sleep(0.5)

        browser.close()

    # Simpan perubahan database
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')

    print(f'\n{"="*62}')
    print(f'  SELESAI')
    print(f'  ✅ Berhasil  : {ok} file ({total_kb//1024} MB total)')
    print(f'  ❌ Gagal     : {fail}')
    print(f'  ⏭  Dilewati  : {skip}')
    print(f'{"="*62}\n', flush=True)


if __name__ == '__main__':
    main()

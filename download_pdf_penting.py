"""
download_pdf_penting.py
Download PDF publikasi penting untuk index chatbot
"""
import json, time, re, urllib.request, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(__file__).parent
SAVE = BASE / 'uploads' / 'files'
DB   = BASE / 'db' / 'publikasi.json'
SAVE.mkdir(parents=True, exist_ok=True)

# Publikasi penting yang harus didownload
PRIORITAS = [
    "dalam angka 2026",
    "statistik daerah",
    "potensi desa",
    "sensus pertanian 2023",
    "ketenagakerjaan",
    "kemiskinan",
    "dalam angka 2025",
    "dalam angka 2024",
]

def slug(judul):
    s = re.sub(r'[\\/:*?"<>|]', ' ', judul)
    return re.sub(r'\s+', '_', s.strip())[:80] + '.pdf'

def download_bytes(url):
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
            'Referer': 'https://jenepontokab.bps.go.id/'})
        with urllib.request.urlopen(req, timeout=90) as r:
            data = r.read()
        return data if len(data) > 10000 else None
    except Exception as e:
        print(f'    download error: {e}')
        return None

def ambil_link(page, url):
    try:
        page.goto(url, wait_until='networkidle', timeout=40000)
        for _ in range(15):
            t = page.title()
            if 'moment' not in t.lower():
                break
            time.sleep(1)
        time.sleep(2)
        return page.evaluate('''() => {
            for(const a of document.querySelectorAll("a"))
                if(a.href && (a.href.includes("download") || a.href.includes(".pdf")))
                    return a.href;
            return null;
        }''')
    except Exception as e:
        print(f'    ambil link error: {e}')
        return None

def main():
    data = json.loads(DB.read_text('utf-8'))

    # Pilih publikasi prioritas
    target = []
    seen_url = set()
    for kk in PRIORITAS:
        for p in data:
            judul = p.get('judul', '').lower()
            url   = p.get('url', '')
            fname = slug(p.get('judul', ''))
            fpath = SAVE / fname
            if kk in judul and url not in seen_url:
                if fpath.exists() and fpath.stat().st_size > 10000:
                    print(f'  [SUDAH ADA] {p["judul"][:60]}')
                    if not p.get('fileLokal'):
                        p['fileLokal'] = f'/uploads/files/{fname}'
                    seen_url.add(url)
                    continue
                target.append(p)
                seen_url.add(url)
                if len(target) >= 15:
                    break

    if not target:
        print('Semua PDF prioritas sudah ada.')
        DB.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
        return

    print(f'\nAkan download {len(target)} PDF penting...')
    for i, p in enumerate(target):
        print(f'  [{i+1}/{len(target)}] {p["judul"][:60]}')

    print('\nBuka browser...')
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=False, slow_mo=60,
            args=['--disable-blink-features=AutomationControlled'])
        ctx = b.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
            locale='id-ID', viewport={'width': 1280, 'height': 800})
        ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        page = ctx.new_page()

        ok = 0
        for i, pub in enumerate(target):
            judul = pub.get('judul', '')
            fname = slug(judul)
            fpath = SAVE / fname
            print(f'\n  [{i+1}/{len(target)}] {judul[:55]}...')

            dl = ambil_link(page, pub['url'])
            if not dl:
                print('    Tidak ada link download')
                continue

            data_bytes = download_bytes(dl)
            if data_bytes:
                fpath.write_bytes(data_bytes)
                pub['fileLokal'] = f'/uploads/files/{fname}'
                ok += 1
                print(f'    OK {len(data_bytes)//1024} KB -> {fname}')
            else:
                print('    Gagal download')

            # Simpan progress
            if (i+1) % 3 == 0:
                DB.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')

        b.close()

    DB.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
    print(f'\nSelesai: {ok}/{len(target)} berhasil didownload')
    print(f'PDF tersimpan di: {SAVE}')

if __name__ == '__main__':
    main()

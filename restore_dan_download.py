""" 
restore_dan_download.py  v2
1. Restore semua publikasi dari BPS Jeneponto
2. Download PDF ke lokal
3. Update db/publikasi.json

Jalankan: python -u restore_dan_download.py
"""

import json, sys, time, re, argparse, urllib.request
from pathlib import Path

BASE = Path(__file__).parent
OUT  = BASE / 'db' / 'publikasi.json'
SAVE = BASE / 'uploads' / 'files'
SAVE.mkdir(parents=True, exist_ok=True)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[ERROR] pip install playwright"); sys.exit(1)

BASE_URL = 'https://jenepontokab.bps.go.id/id/publication'


# ── helpers ────────────────────────────────────────────────────────────────

def tunggu_cf(page, timeout=30):
    """Tunggu sampai Cloudflare challenge selesai (maks timeout detik)."""
    for _ in range(timeout):
        title = page.title()
        if 'moment' not in title.lower() and 'challenge' not in title.lower():
            return True
        time.sleep(1)
    return False


def buka(page, url, retry=3):
    for i in range(retry):
        try:
            page.goto(url, wait_until='networkidle', timeout=45000)
            if not tunggu_cf(page):
                print(f'\n  [WARN] Cloudflare timeout di {url}', flush=True)
            time.sleep(2)
            return True
        except Exception as e:
            if i == retry - 1:
                print(f'\n  [ERR] buka gagal: {e}', flush=True)
                return False
            time.sleep(3)
    return False


def parse(page):
    return page.evaluate('''() => {
        const cards = document.querySelectorAll("a.rounded-xl");
        return Array.from(cards).map(c => {
            const j  = c.querySelector("p[class*='text-main-primary']");
            const t  = c.querySelector("p[class*='caption']");
            const d  = c.querySelector("p[class*='overflow-text-ellipsis']");
            const im = c.querySelector("img[alt]");
            const judul    = j  ? j.innerText.trim()  : "";
            const tanggal  = t  ? t.innerText.trim()  : "";
            const deskripsi= d  ? d.innerText.trim()  : "";
            const cover    = im ? im.src               : "";
            const tm       = tanggal.match(/\\b(20\\d{2})\\b/);
            const tahun    = tm ? parseInt(tm[1]) : null;
            const jl = judul.toLowerCase();
            let kat = "Lainnya";
            if(jl.includes("dalam angka"))           kat="Dalam Angka";
            else if(jl.includes("statistik daerah")) kat="Statistik Daerah";
            else if(jl.includes("pdrb")||jl.includes("produk domestik")) kat="PDRB";
            else if(jl.includes("ipm")||jl.includes("pembangunan manusia")) kat="IPM";
            else if(jl.includes("kemiskinan"))        kat="Kemiskinan";
            else if(jl.includes("ketenagakerjaan"))   kat="Ketenagakerjaan";
            else if(jl.includes("pertanian"))         kat="Pertanian";
            else if(jl.includes("kesejahteraan"))     kat="Kesejahteraan";
            else if(jl.includes("kecamatan"))         kat="Kecamatan";
            else if(jl.includes("inflasi")||jl.includes("harga")) kat="Harga & Inflasi";
            else if(jl.includes("potensi desa"))      kat="Potensi Desa";
            return {judul,tanggal,tahun,deskripsi,kategori:kat,cover,url:c.href||""};
        }).filter(x=>x.judul.length>3&&x.url.includes("/publication/"));
    }''')


def ambil_total(page):
    return page.evaluate('''() => {
        const m = document.body.innerText.match(/dari\\s+([\\d.,]+)\\s+Publikasi/i);
        if(m) return parseInt(m[1].replace(/[.,]/g,""),10);
        // fallback: hitung manual dari pagination
        const last = Array.from(document.querySelectorAll("button[aria-label],a[aria-label]"))
            .map(e=>parseInt(e.textContent.trim())).filter(n=>!isNaN(n));
        return last.length ? Math.max(...last)*10 : 0;
    }''')


def slug(judul):
    s = re.sub(r'[\\/:*?"<>|]', ' ', judul)
    return re.sub(r'\\s+', '_', s.strip())[:80] + '.pdf'


def download(url, path):
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
            'Referer':    'https://jenepontokab.bps.go.id/'})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        if len(data) < 500: return False, 0
        path.write_bytes(data)
        return True, len(data)
    except:
        return False, 0


def ambil_dl_link(page, pub_url):
    try:
        page.goto(pub_url, wait_until='networkidle', timeout=40000)
        tunggu_cf(page)
        time.sleep(2)
        return page.evaluate('''() => {
            for(const a of document.querySelectorAll("a"))
                if(a.href && a.href.includes("download")) return a.href;
            return null;
        }''')
    except:
        return None


def prog(n, total, jumlah):
    pct    = round(n / total * 100)
    filled = round(pct / 5)
    bar    = '#' * filled + '.' * (20 - filled)
    sys.stdout.write(f'\r  [{bar}] {pct}% - Hal {n}/{total} - {jumlah} pub  ')
    sys.stdout.flush()
    if n == total:
        print()


# ── main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hanya-scrape',   action='store_true', help='Hanya scrape, tidak download PDF')
    parser.add_argument('--hanya-download', action='store_true', help='Hanya download PDF')
    parser.add_argument('--mulai-dl',       type=int, default=0, help='Mulai download dari indeks ke-N')
    parser.add_argument('--headless',       action='store_true', help='Paksa headless (mungkin diblokir CF)')
    args = parser.parse_args()

    headed = not args.headless   # default: jendela browser muncul (bisa bypass CF)

    print(f'\n{"="*62}', flush=True)
    print(f'  RESTORE PUBLIKASI + DOWNLOAD PDF BPS JENEPONTO  v2', flush=True)
    print(f'  Mode: {"headless" if args.headless else "HEADED (jendela browser terbuka)"}', flush=True)
    print(f'{"="*62}\n', flush=True)

    with sync_playwright() as pw:
        b = pw.chromium.launch(
            headless=not headed,
            slow_mo=80,
            args=['--disable-blink-features=AutomationControlled',
                  '--no-sandbox']
        )
        ctx = b.new_context(
            user_agent=(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/124.0.0.0 Safari/537.36'
            ),
            locale='id-ID',
            viewport={'width': 1280, 'height': 800},
            java_script_enabled=True,
        )
        # Sembunyikan tanda otomasi
        ctx.add_init_script("""
            Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
            window.chrome = {runtime:{}};
        """)
        page = ctx.new_page()

        # ── FASE 1: SCRAPE ──────────────────────────────────────────
        if not args.hanya_download:
            print('FASE 1: Scraping daftar publikasi dari BPS...', flush=True)
            if headed:
                print('  >> Jendela browser akan terbuka. Jika ada CAPTCHA/CF, selesaikan manual.', flush=True)
                print('  >> Tunggu beberapa detik, scraper akan lanjut otomatis.', flush=True)

            # Halaman 1 – deteksi total
            buka(page, f'{BASE_URL}?page=1')
            total     = ambil_total(page)
            total_hal = max((total + 9) // 10, 1)
            print(f'  Total: {total} publikasi, {total_hal} halaman', flush=True)

            if total == 0:
                print('  [WARN] Tidak dapat mendeteksi total — akan coba 40 halaman', flush=True)
                total_hal = 40

            semua  = []
            urlset = set()

            h1 = parse(page)
            for p in h1:
                if p['url'] not in urlset:
                    semua.append(p)
                    urlset.add(p['url'])
            prog(1, total_hal, len(semua))

            for n in range(2, total_hal + 1):
                ok = buka(page, f'{BASE_URL}?page={n}')
                if not ok:
                    print(f'\n  Halaman {n} gagal, coba lanjut...', flush=True)
                    continue
                items = parse(page)
                if not items:
                    print(f'\n  Halaman {n} kosong — selesai.', flush=True)
                    break
                for p in items:
                    if p['url'] not in urlset:
                        semua.append(p)
                        urlset.add(p['url'])
                prog(n, total_hal, len(semua))

                # Simpan progress tiap 5 halaman
                if n % 5 == 0:
                    OUT.write_text(json.dumps(semua, ensure_ascii=False, indent=2), 'utf-8')

            print(f'\n  Berhasil scrape {len(semua)} publikasi', flush=True)

            # Gabung dengan data lokal
            existing = []
            if OUT.exists():
                try:
                    existing = [p for p in json.loads(OUT.read_text('utf-8'))
                                if p.get('lokal') and p.get('url') not in urlset]
                except:
                    pass
            final = semua + existing
            OUT.write_text(json.dumps(final, ensure_ascii=False, indent=2), 'utf-8')
            data = final
            print(f'  Disimpan {len(final)} total ke {OUT.name}', flush=True)

        else:
            data = json.loads(OUT.read_text('utf-8'))
            print(f'Menggunakan data yang ada: {len(data)} publikasi', flush=True)

        # ── FASE 2: DOWNLOAD PDF ────────────────────────────────────
        if not args.hanya_scrape:
            print(f'\nFASE 2: Download PDF...', flush=True)
            target = [p for p in data if p.get('url', '').startswith('http')]
            target = target[args.mulai_dl:]
            ok_dl = 0; fail_dl = 0

            for i, pub in enumerate(target):
                n     = args.mulai_dl + i + 1
                judul = pub.get('judul', '')
                fname = slug(judul)
                fpath = SAVE / fname

                print(f'  [{n:3}/{len(target)+args.mulai_dl}] {judul[:50]}...', flush=True)

                if fpath.exists() and fpath.stat().st_size > 10000:
                    print(f'           Sudah ada ({fpath.stat().st_size//1024} KB)', flush=True)
                    pub['fileLokal'] = f'/uploads/files/{fname}'
                    ok_dl += 1
                    continue

                dl = ambil_dl_link(page, pub['url'])
                if not dl:
                    print(f'           Link download tidak ada', flush=True)
                    fail_dl += 1
                    continue

                success, size = download(dl, fpath)
                if success:
                    print(f'           OK {size//1024} KB', flush=True)
                    pub['fileLokal'] = f'/uploads/files/{fname}'
                    ok_dl += 1
                else:
                    print(f'           Gagal download', flush=True)
                    fail_dl += 1

                if (i + 1) % 10 == 0:
                    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
                    print(f'  Progress tersimpan ({ok_dl} berhasil)', flush=True)

                time.sleep(0.5)

            OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
            print(f'\n  Download selesai: {ok_dl} berhasil, {fail_dl} gagal', flush=True)

        b.close()

    print(f'\n{"="*62}', flush=True)
    print(f'  SELESAI!', flush=True)
    print(f'  Data: {OUT}', flush=True)
    print(f'  PDF : {SAVE}', flush=True)
    print(f'{"="*62}\n', flush=True)


if __name__ == '__main__':
    main()

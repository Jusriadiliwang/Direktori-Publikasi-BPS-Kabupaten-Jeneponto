"""
scrape_tabel_data.py - v2
Ambil data ACTUAL dari Query Builder BPS Jeneponto untuk semua var_id
"""
import json, time, sys, argparse, re
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(__file__).parent
META = BASE / 'db' / 'tabel-dinamis.json'
OUT  = BASE / 'db' / 'tabel-dinamis-data.json'


def parse_rsc(text):
    res = []
    for line in (text or '').split('\n'):
        if not line or not line[0].isdigit() or ':' not in line:
            continue
        try:
            res.append(json.loads(line.split(':', 1)[1]))
        except:
            pass
    return res


def find_data(obj):
    """Cari objek data tabel (datacontent / data) dari hasil RSC secara rekursif."""
    if isinstance(obj, dict):
        if obj.get('datacontent') is not None:
            return obj
        if obj.get('data') is not None and isinstance(obj['data'], dict):
            if obj['data'].get('datacontent') is not None:
                return obj['data']
        for v in obj.values():
            r = find_data(v)
            if r: return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_data(v)
            if r: return r
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mulai', type=int, default=0)
    parser.add_argument('--maks',  type=int, default=999)
    parser.add_argument('--single', type=int, default=None)
    args = parser.parse_args()

    meta = json.loads(META.read_text('utf-8'))
    indikator = meta.get('indikator', [])
    print(f'Total indikator metadata: {len(indikator)}')

    hasil = {}
    if OUT.exists():
        hasil = json.loads(OUT.read_text('utf-8'))

    if args.single:
        target = [i for i in indikator if i['var_id'] == args.single]
    else:
        target = indikator[args.mulai:args.mulai + args.maks] if args.mulai else indikator[:args.maks]
    print(f'Akan proses {len(target)} indikator\n')

    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=False, slow_mo=40,
            args=['--disable-blink-features=AutomationControlled'])
        ctx = b.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
            locale='id-ID', viewport={'width': 1300, 'height': 850})
        ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        page = ctx.new_page()

        action_data = None
        action_setup = None   # action untuk dapetin list var/tahun kadang sama

        def cap_req(req):
            global action_data
            if req.method != 'POST' or 'query-builder' not in req.url:
                return
            na   = req.headers.get('next-action')
            body = req.post_data or ''
            if not na:
                return
            if '"var_id"' in body:
                action_data = na
            print(f'  [req] {na[:20]} | {body[:90]}')

        page.on('request', cap_req)

        # SEGERA panggil fetch untuk memicu action setup bahkan sebelum load penuh
        page.goto('https://jenepontokab.bps.go.id/id/query-builder',
                  wait_until='domcontentloaded', timeout=50000)
        # Tunggu CF + render
        for _ in range(20):
            t = page.title()
            if 'moment' not in t.lower():
                break
            time.sleep(1)
        time.sleep(2)

        print(f'\nAction data terdeteksi: {action_data}')

        if not action_data:
            # Trigger manual dengan mencoba klik / fetch
            print('Tidak terdeteksi otomatis, coba manual fetch...')
            try:
                pg_text = page.content()
                print('  (mencari action di HTML...)')
                m = re.findall(r'([a-f0-9]{40})', pg_text)
                print(f'  Hash: {m[:5]}')
            except:
                pass
            b.close()
            return

        ok = 0; fail = 0
        for i, ind in enumerate(target):
            vid   = ind['var_id']
            judul = ind.get('judul', '')

            # Ambil tahun + data dalam satu action (format variatif)
            data = None
            years = []
            try:
                # coba dengan berbagai format body
                for body_variant in ['', '2010']:
                    r = page.evaluate("""async ([action, vid, thn]) => {
                        const body = [{locale:'id', var_id:vid, tahun: thn || null}];
                        const r = await fetch('/id/query-builder', {
                            method:'POST',
                            headers:{'Content-Type':'text/plain;charset=UTF-8','Next-Action':action},
                            body: JSON.stringify(body),
                        });
                        return await r.text();
                    }""", [action_data, vid, body_variant])
                    resp = parse_rsc(r)
                    d = find_data(resp)
                    if d:
                        data = d
                        break
                # ambil tahun list
                for o in resp if 'resp' in dir() else []:
                    pass
            except Exception as e:
                print(f'    [err] {e}')

            if data:
                dc = data.get('datacontent')
                rows = dc if isinstance(dc, list) else []
                hasil[str(vid)] = {'var_id': vid, 'judul': judul, 'data': data}
                ok += 1
                print(f'  [{i+1}/{len(target)}] {judul[:40]} -> OK {len(rows)} baris')
            else:
                fail += 1
                print(f'  [{i+1}/{len(target)}] {judul[:40]} -> GAGAL')

            if (i + 1) % 5 == 0:
                OUT.write_text(json.dumps(hasil, ensure_ascii=False, indent=2), 'utf-8')
            time.sleep(0.4)

        b.close()

    OUT.write_text(json.dumps(hasil, ensure_ascii=False, indent=2), 'utf-8')
    print(f'\nSELESAI: {ok} ok, {fail} fail -> {OUT}')


if __name__ == '__main__':
    main()
